# Your requests

These are the requests the server sends Go over the socket, and Go answers each one. They tell Go what changed in a trip, and they ask the questions that need an answer straight away: someone tapped a button on a Go card, someone came back to the room, someone wants to see or change what Go knows about them, or someone wants to open their vault. This page lists each request, when the server sends it, what Go answers, and what the app shows when Go does not answer in time. The one HTTP route left on Go, `GET /v1/health`, is at the end.

The server sends all 8 of these requests with `go.request(method, params)` on the `GoSocket` client from [The socket](02-the-socket.md#a-complete-client-for-the-server). Each one gets an answer: none of them is a notification. The app never talks to Go for any of them. It asks the server, and the server sends the request for the person who is signed in.

## The requests

| Method | Params | Result | Answer within | Server sends it when |
|---|---|---|---|---|
| `send_event` | An event, such as `MessageCreated` | `EventAccepted` | 2 seconds | Anything changes in a trip |
| `card_tap` | `CardTap` | `ActionDone`, `ActionOpen` or `ActionRefused` | 3 seconds | Someone taps a button on a Go card |
| `catch_up` | `CatchUpRequest` | `CatchUp` | 3 seconds | Someone opens the room after a while |
| `get_person` | `GetPerson` | `PersonPage` | 2 seconds | Someone opens "What Go knows about you" |
| `update_person` | `UpdatePerson` | `Ok` | 2 seconds | Someone turns carry-over on or off |
| `delete_fact` | `DeleteFact` | `Ok` | 2 seconds | Someone removes one thing Go knows about them |
| `forget_person` | `ForgetPerson` | `ForgetResult` | 2 seconds | Someone taps "Forget me" |
| `vault_link` | `CreateLink` | `Link` | 2 seconds | Someone opens their cards and logins from the You screen |
| `place_info` (1.3) | `PlaceInfoRequest` | `PlaceInfo` | 3 seconds | The server refreshes an idea on the home screen, at most once a day per idea |
| `get_option_details` (1.3) | `GetOptionDetails` | `OptionFullDetails` | 3 seconds | Someone opens an option's Details |

Your monitoring can also call `GET /v1/health` over HTTP. It is not signed. See [Health](#health-get-v1health).

Good to know:
- Take `person_id` from the app's signed-in session, never from what the app sends. Nobody can act as someone else, or read or delete someone else's facts.
- Apart from `send_event`, do not send a request again on your own. A person is waiting, so show them that it did not work and let them try again.
- The `GoSocket` client still sends a waiting request again, with the same `id`, after a reconnect, and the caller just keeps waiting. That is safe: `card_tap` carries its own `tap_id`, so Go acts on it once, and the other requests only read (`get_person`, `catch_up`, `vault_link`) or leave the same result when done twice (`update_person`, `delete_fact`, `forget_person`).
- Go answers an error with a `SocketError` frame, and the client turns it into a `SocketCallError`. When no answer comes in time, the client fails with `SocketTimeoutError` (TypeScript) or `asyncio.TimeoutError` (Python). For everything on this page except `send_event`, treat an error, a timeout and an answer that does not match the contract the same way: show the person the message given in that request's section.

## Events: `send_event`

The server tells Go about every change to a trip with a `send_event` request, whoever made the change: a person, Go or the server itself. Its params are the whole event (a `MessageCreated`, a `DecisionClosed` and so on), and Go answers `{"accepted": true, "duplicate": false}` within 2 seconds, then does the real work afterwards. The server sends each trip's events one at a time, in change-number order, from an outbox written in the same transaction as the change, and it sends a failed event again on a fixed schedule. Every event type, the outbox and the sender are on their own page: [Events](03-events.md).

When a message for Go arrives (someone mentions Go, names it, or replies to it), Go waits about 2 seconds in case the same person sends more, unless the message plainly ends with a question mark, a full stop, an exclamation mark or an emoji. Just before it posts its answer, it checks the room for anything new for it and answers that too. This is Go's own behaviour: the server has nothing to send for it.

## Card taps: `card_tap`

The server sends `card_tap` when someone taps a button on a Go card, and passes Go's answer back to the app. Go cards are the five kinds that carry their own buttons in `actions`: `options`, `working`, `call`, `pay` and `notice`.

Forward only taps on Go cards. Buttons on record cards (`vote`, `mandate`, `ticket`, `expense`, `settle_up`, `day`, `plan` and `budget`) belong to the server, which handles them itself. For example, the vote buttons and the mandate card's "Yes, book it" and "Not now" are the server's own, and Go learns about them from events (`decision.voted`, `mandate.confirmed` and `mandate.declined`).

### The request

The params name the tap, the trip and the card, which button was tapped, and who tapped it.

| Param | What it is |
|---|---|
| `tap_id` | The server's id for this tap, new for every tap. Go acts on each `tap_id` once, so a tap that arrives twice (sent again after a reconnect, or a double tap) does its work once. |
| `trip_id` | The trip whose room the card is in. |
| `card_id` | The card the button is on. |
| `action_id` | The `action_id` of the button, from the card's `actions`. |
| `person_id` | The person who tapped, from the app's signed-in session. |
| `option_id` | Only for a button with `per_option: true` on an options card. It is the `option_id` of the option the person tapped the button on. |

Priya taps "I'll take this" on the first flight of the `c_flights_1` card, so the server sends:

<!-- schema: CardTap -->
```json
{ "tap_id": "tap_0412", "trip_id": "t_goa", "card_id": "c_flights_1", "action_id": "pick", "person_id": "p_priya", "option_id": "opt_flight_1" }
```

These are the buttons Go usually puts on its cards. The server forwards every tapped `action_id` as it is, so a new button needs no change in the server.

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

Go answers within 3 seconds with one of three results. The app handles each one like this:

| `result` | What the app does |
|---|---|
| `done` | Shows `toast`, if there is one. Go follows up in the room, or replaces the card in place. |
| `open` | Opens `url` in the system browser sheet straight away. The link stops working at `expires_at`. Some of these pages close by themselves when Go is done with them, such as the ixigo login's (see [Closing a page Go opened](06-cards.md#closing-a-page-go-opened)). |
| `refused` | Shows `toast`. Nothing changed, because the tap is not allowed or no longer possible. |

Priya's pick is done, and Go will follow up in the room:

<!-- schema: ActionDone -->
```json
{ "result": "done", "toast": "Noted: you picked the 6:10 pm IndiGo." }
```

When Rahul taps Approve on the villa's pay card, the server sends:

<!-- schema: CardTap -->
```json
{ "tap_id": "tap_0457", "trip_id": "t_goa", "card_id": "c_villa_pay", "action_id": "approve", "person_id": "p_rahul" }
```

and Go answers with the vault page to open:

<!-- schema: ActionOpen -->
```json
{ "result": "open", "url": "https://brain.go.example/vault/approve?link=lk_4Rt8Zp2Lq", "expires_at": "2026-10-05T09:06:30Z" }
```

Arjun taps Stop on the call card (`c_villa_call`) just after the call to Villa Sol ended, so Go refuses:

<!-- schema: ActionRefused -->
```json
{ "result": "refused", "toast": "The call has already ended." }
```

The app opens an `open` URL with Flutter's `url_launcher` in `LaunchMode.inAppBrowserView`, which is SFSafariViewController on iOS and Chrome Custom Tabs on Android. Never open it in `webview_flutter`: passkeys (Face ID) do not work inside a plain WebView, so the payer could not pay there. A link expires 5 minutes after Go makes it, so the app opens it at once and never keeps it for later. [The App](07-the-app.md#opening-go-pages) has the details.

### If Go does not answer

Wait up to 3 seconds, plus a little for the network (the examples below wait 3.5 seconds). If Go does not answer in time, answers with an error, or answers with something that does not match the contract, show the person a toast such as "Go didn't answer. Try again." and leave the card as it is. Do not send the tap again yourself, because the first one may already have started something. The person decides whether to tap again, and a new tap gets a new `tap_id`.

### Forwarding a tap from the server

This is the server route the app calls when someone taps a button on a Go card. It checks that the card is a Go card in a trip the person belongs to, sends the tap to Go as a `card_tap` request on the socket, waits for the answer, and returns it to the app. When Go does not answer, it returns a `refused`-style toast, so the app handles every outcome the same way. The `/app/...` path is an example: the app's API is yours to design.

**TypeScript**

```ts
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { CardActionResult, CardTap } from '@go/contract';
import { go } from './go.js'; // the one GoSocket the server keeps open, from The socket

const GO_CARD_KINDS = new Set(['options', 'working', 'call', 'pay', 'notice']);
const TRY_AGAIN = { result: 'refused', toast: "Go didn't answer. Try again." } as const;

// Your own code: who is signed in, and the card if it is in a trip they belong to.
declare function signedInPerson(req: FastifyRequest): Promise<string>;
declare function findCard(personId: string, tripId: string, cardId: string): Promise<{ kind: string } | null>;

const app = Fastify();

app.post<{ Params: { tripId: string; cardId: string }; Body: { action_id: string; option_id?: string | null } }>(
  '/app/trips/:tripId/cards/:cardId/actions',
  async (req, reply) => {
    const { tripId, cardId } = req.params;
    const personId = await signedInPerson(req);
    const card = await findCard(personId, tripId, cardId);
    if (!card || !GO_CARD_KINDS.has(card.kind)) return reply.code(404).send();
    try {
      const tap = CardTap.parse({
        tap_id: `tap_${randomUUID()}`, trip_id: tripId, card_id: cardId, action_id: req.body.action_id,
        person_id: personId, option_id: req.body.option_id,
      });
      const answer = await go.request('card_tap', tap, { timeoutMs: 3_500 });
      return CardActionResult.parse(answer); // done, open or refused
    } catch {
      // A bad action_id, no answer in time (SocketTimeoutError), an error frame (SocketCallError),
      // or an answer that does not match the contract.
      return TRY_AGAIN;
    }
  },
);
```

**Python**

```python
import asyncio
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from go_contract import models
from pydantic import BaseModel, ValidationError

from go import go  # the one GoSocket the server keeps open, from The socket
from go_socket import SocketCallError

GO_CARD_KINDS = {"options", "working", "call", "pay", "notice"}
TRY_AGAIN = {"result": "refused", "toast": "Go didn't answer. Try again."}

app = FastAPI()


class Tap(BaseModel):
    action_id: str
    option_id: str | None = None


# Your own code: who is signed in, and the card if it is in a trip they belong to.
async def signed_in_person(request: Request) -> str: ...
async def find_card(person_id: str, trip_id: str, card_id: str) -> dict | None: ...


@app.post("/app/trips/{trip_id}/cards/{card_id}/actions")
async def forward_tap(trip_id: str, card_id: str, tap: Tap, request: Request) -> dict:
    person_id = await signed_in_person(request)
    card = await find_card(person_id, trip_id, card_id)
    if card is None or card["kind"] not in GO_CARD_KINDS:
        raise HTTPException(status_code=404)
    try:
        params = models.CardTap(
            tap_id=f"tap_{uuid4().hex}", trip_id=trip_id, card_id=card_id, action_id=tap.action_id,
            person_id=person_id, option_id=tap.option_id,
        )
        answer = await go.request("card_tap", params.model_dump(exclude_none=True), timeout=3.5)
        result = models.CardActionResult.model_validate(answer)  # done, open or refused
        return result.model_dump(mode="json", exclude_none=True)
    except (asyncio.TimeoutError, SocketCallError, ValidationError):
        # A bad action_id, no answer in time, an error frame, or an answer that does not match the contract.
        return TRY_AGAIN
```

Good to know:
- Go still checks who may use a button. For example, it refuses an `approve` from anyone but the payer, even though the app shows that button only to the payer.
- A tap often changes the card. Go then sends `replace_card` (which sends no event), and the server shows the new card live.
- Disable the button while the tap is on its way, so a double tap sends one request. If the app sends its own id with each press, use it as the `tap_id`, so a double tap that still gets through counts once.

## Catch-up: `catch_up`

The server sends `catch_up` when someone opens the room after being away, and the app shows the answer above the room for that person only. It is never posted in the room. We suggest asking when the person has been away for 3 hours or more, or has 15 or more unread messages.

The params name the trip, the person, and when they last looked at the room. Meher opens the room after a morning away, so the server sends:

<!-- schema: CatchUpRequest -->
```json
{ "trip_id": "t_goa", "person_id": "p_meher", "since": "2026-10-05T03:30:00Z" }
```

Go answers within 3 seconds with a `summary` and up to five `items`:

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

If Go fails or takes longer than 3 seconds, hide the catch-up. Never hold the room back for it: show the room at once, send `catch_up` at the same time, and slide the catch-up in when it arrives. [The App](07-the-app.md#catch-up) has the server code.

## What Go knows about a person

Go keeps a page for each person listing every fact it saved about them, with where each fact came from. The server reads it when someone opens "What Go knows about you" on the You screen, and uses the next two requests when they change it.

### `get_person`: read a person's page

`get_person` returns the person's page: whether carry-over is on, and their facts from every trip. Kabir opens "What Go knows about you", so the server sends:

<!-- schema: GetPerson -->
```json
{ "person_id": "p_kabir" }
```

Go answers:

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
| `fact_id` | Go's id for the fact. Use it to delete the fact. |
| `topic` | What the fact is about, such as `food`, `flights` or `sleep`. A person has one current fact per topic. |
| `text` | The fact in plain words, up to 200 characters. |
| `trip_id` | The trip Go learned it in. Show the trip's title next to the fact. |
| `message_id` | The message the fact came from, so a tap can open it. `null` when it came from a join answer. |
| `said_at` | When they said it. |

Every fact came from something the group can see: a message in the room or a join answer. Go never learns anyone's own budget answer, so it never appears here.

If Go fails or takes longer than 2 seconds, show the rest of the You screen as usual and, in place of the list, a line such as "Couldn't load what Go knows. Try again." with a button to try again.

### `update_person`: turn carry-over on or off

Carry-over decides whether what a person told Go carries into their next trips. It is off by default, so Go uses a fact only in the trip where it learned it. The server sends `update_person` when the person flips the switch, which the app can label "Remember me in my next trips":

<!-- schema: UpdatePerson -->
```json
{ "person_id": "p_kabir", "carry_over": true }
```

Go answers:

<!-- schema: Ok -->
```json
{ "ok": true }
```

If Go fails or takes longer than 2 seconds, put the switch back where it was and show "Couldn't save. Try again."

### `delete_fact`: delete one fact

The server sends `delete_fact` when the person removes one fact from their page. Kabir removes his seat preference:

<!-- schema: DeleteFact -->
```json
{ "person_id": "p_kabir", "fact_id": "f_kb_02" }
```

Go answers `{"ok": true}`, like `update_person`. Go stops using the fact at once. The message it came from stays in the room.

If Go fails or takes longer than 2 seconds, keep showing the fact and show "Couldn't delete that. Try again."

Good to know:
- A `404` `not_found` error means the fact is already gone, so remove it from the screen.

## Forget me: `forget_person`

"Forget me" deletes what Go learned about a person. The server sends `forget_person` when someone taps "Forget me in this trip" (with `trip_id`, only what Go learned in that trip) or "Forget me everywhere" on the You screen (without `trip_id`, everything Go learned about them in every trip).

Kabir asks Go to forget what it learned in the Goa trip, so the server sends:

<!-- schema: ForgetPerson -->
```json
{ "person_id": "p_kabir", "trip_id": "t_goa" }
```

Go deletes his facts from that trip, checks that none are left, and then answers:

<!-- schema: ForgetResult -->
```json
{ "deleted_facts": 3, "remaining_facts": 0 }
```

Without `trip_id` (`{"person_id": "p_kabir"}`), Go deletes his facts from every trip, and the answer has the same shape. `remaining_facts` is always `0` in a success, because Go checks before it answers. Show the person how many things Go forgot.

| What forget me deletes | What stays |
|---|---|
| Go's facts about the person, in that trip or in every trip | The person's messages in the room, because the rest of the group can still see them |
| The person's join answers (`from_city`, `earliest_leave`, `know`) in those trips: the server clears them, so Go cannot learn them again from the trip | Their votes, bookings, expenses and trip record lines, which belong to the trip |

The server clears the join answers itself, after Go answers, and sends `person.updated` for each trip. The person can give new answers later if they want Go to plan with them again.

Forget me does not stop Go from learning from new messages. To do that, the person pauses Go in the trip (see [`person.updated`](03-events.md#personupdated)).

If Go fails or takes longer than 2 seconds, never tell the person they were forgotten. Show "Go couldn't forget you just now. Try again." Asking again is safe: Go deletes whatever is left and checks again that nothing remains.

## Vault links: `vault_link`

The server sends `vault_link` when someone opens their cards and logins from the app's You screen. Go answers with a short-lived link to its vault page, which the app opens in the system browser sheet. There the person adds a card or a login and confirms it with Face ID. The first time someone adds a card, the vault creates their passkey, so a payer needs no Vestra account.

The params say which part of the vault to open: `home`, `add_card` or `add_login`. Rahul adds a card before the villa is paid for, so the server sends:

<!-- schema: CreateLink -->
```json
{ "kind": "vault", "person_id": "p_rahul", "start": "add_card" }
```

Go answers with the link and when it stops working:

<!-- schema: Link -->
```json
{ "url": "https://brain.go.example/vault/add-card?link=lk_9Wm3Hc6Ty", "expires_at": "2026-10-05T08:55:00Z" }
```

The link expires 5 minutes after Go makes it. Ask for it only when the person taps, open it straight away in the system browser sheet (`url_launcher` with `LaunchMode.inAppBrowserView`), and never open it in `webview_flutter`. The link is made for that one person and is not for sharing.

If Go fails or takes longer than 2 seconds, show "Couldn't open your cards. Try again."

1.3 adds `display`: `sheet` (the default) opens the link in the system browser sheet, as above. `embedded` asks for a page the app shows inside itself, for `start: "home"` only: the person unlocks there and sees what their vault holds. The page allows framing only by the app's origins, needs no third-party cookies, and when it is done it posts `{ "type": "go-vault", "status": "saved" | "cancelled" | "failed" }` to its parent window. Adding a card or a login always opens in the sheet: Go answers `display: "embedded"` with any other `start` with a 409 `conflict` error, so open that one in the sheet.

<!-- schema: CreateLink -->
```json
{ "kind": "vault", "person_id": "p_rahul", "start": "home", "display": "embedded" }
```

## Place ideas: `place_info` (1.3)

The home screen's ideas are the server's own, picked for each starting city. To show each with real photos, the server asks Go what the place is like. It asks at most once a day per idea, keeps the answer, and never asks while a person waits.

<!-- schema: PlaceInfoRequest -->
```json
{ "name": "Ladakh", "from_city": "Delhi" }
```

Go answers with the place and 6 to 12 photos when it has them, a one-line tag, the usual way there from that city, and the best months (1 to 12):

<!-- schema: PlaceInfo -->
```json
{
  "place": {
    "name": "Ladakh",
    "lat": 34.1526,
    "lng": 77.5771,
    "photos": [
      { "url": "https://brain.go.example/img/ladakh-pangong.jpg", "label": "Pangong Lake" },
      { "url": "https://brain.go.example/img/ladakh-khardung.jpg", "label": "Khardung La" }
    ]
  },
  "tag": "High-altitude road trip",
  "travel": { "mode": "flight", "duration_minutes": 85 },
  "best_months": [6, 7, 8, 9]
}
```

`complete`: absent or `true` means the whole answer. `false` means partial (photos still coming): show it, but don't keep it, and ask again later.

Until Go answers it, `place_info` gets a 409 `conflict` error, "not available yet": keep the idea's own image.

## An option's Details: `get_option_details` (1.3)

An options card carries what fits on a card. When someone opens an option's Details, the server asks Go for the rest:

<!-- schema: GetOptionDetails -->
```json
{ "trip_id": "t_goa", "card_id": "c_opts_3", "option_id": "opt_2", "person_id": "p_priya" }
```

Go answers with everything an option's `details` can hold, and more. Every field is optional: show what is there.

<!-- schema: OptionFullDetails -->
```json
{
  "caption": "A quiet villa a short walk from Anjuna beach",
  "rating": 4.6,
  "review_count": 212,
  "cancellation": "Free cancellation until 4 Nov",
  "address": "Grande Vaddo, Anjuna, Goa 403509",
  "map": { "lat": 15.5794, "lng": 73.7426 },
  "check_in": "14:00",
  "check_out": "11:00",
  "property_type": "villa",
  "stars": 4,
  "rooms": [
    { "room_type_id": "rt_deluxe", "label": "Deluxe room", "sleeps": 2, "price_minor": 2400000, "photos": [{ "url": "https://brain.go.example/img/sol-deluxe.jpg", "label": "Deluxe room" }] }
  ],
  "policies": ["No pets", "Quiet hours 22:00 to 07:00"],
  "reviews": [{ "rating": 4.5, "text": "Lovely pool and very helpful staff.", "date": "2026-09-12", "source": "ixigo" }],
  "nearby": [{ "name": "Anjuna beach", "distance_m": 600 }],
  "url": "https://www.ixigo.com/hotels/4395492/details",
  "complete": true
}
```

A review's `date` is `YYYY-MM-DD`, or `YYYY-MM` when the source gives only the month. `complete`: absent or `true` means the whole answer. `false` means partial (reviews or photos still coming): show it, but don't keep it, and ask again later.

The server keeps a complete answer an hour per option. Until Go answers it, `get_option_details` gets a 409 `conflict` error, "not available yet": show the option's own `details`.

## Health: `GET /v1/health`

`GET /v1/health` says whether Go is up and which contract version it speaks. It is a plain HTTP request, not a socket request, and it is not signed, so any monitoring tool can call it:

```bash
curl https://brain.go.example/v1/health
```

<!-- schema: Health -->
```json
{ "ok": true, "contract": "1.3.0" }
```

Check that `contract` starts with `1.`. Within version 1, the contract only adds things, so a Go that speaks any `1.x` works with a server built for `1.0.0`.

If health fails, Go is down, usually for a deploy, and the socket is closed too. Nothing is lost: events wait in the server's outbox and go out in order once the socket is back, card taps show "Try again", and the room opens without a catch-up. The `GoSocket` client reconnects by itself, so it does not need the health check.
