# The app

This page explains what go-app and the server must do so that Go feels like a live member of the room: what the app's live connection carries (including typing and reactions, Go's and everyone's), how to draw Go's messages and cards, the "needs you" strip, pushes, catch-up, "Ask Go about this", the You screen, and opening go-brain pages. It is for Saket's team, who build go-app, and Nishanth's team, who build the server.

The app's own API and its live connection belong to the Go team, so the shapes on this page between the app and the server are recommendations and CI does not check them. What the contract does fix is the data that travels through them: the `Message` and card JSON, and the requests the server sends go-brain on the socket for the app.

## What the app talks to

The app talks only to the server. The server stores everything the app shows, and it sends every request to go-brain on the app's behalf, on the one socket it keeps open to go-brain (see [The socket](02-the-socket.md)). The server opened that socket with a signature made from a secret the app never sees.

There is one exception. A few things happen on go-brain's own pages: the vault, where a person adds a card or approves a payment, and the page where someone watches Go work on a website. The app opens those pages from a short-lived link in the system browser sheet (see [Opening go-brain pages](#opening-go-brain-pages)).

Good to know:
- The app never connects to go-brain's socket and never holds `GO_SIGNING_SECRET`. Anyone who downloads an app can read a secret inside it.
- The app never needs go-brain's address. Every link it opens comes from the server, ready to use.

## The live connection

The live connection sends each change in a trip to every phone that has the trip open, so people see new messages, reactions, who is typing and votes moving without pulling to refresh. The server chooses how to do it: Supabase Realtime, a WebSocket or server-sent events all work. Open it when the person opens a trip's room or Trip screens, and close it when they leave. Pushes cover the rest (see [Pushes](#pushes)).

We recommend four kinds of message from the server to the app. The shapes below are only a recommendation: the Go team owns them, can change them, and CI does not check them.

**A new or changed message.** Send the whole `Message` from the contract, unchanged, including Go's card. Send it again whenever the message changes: an edit, a delete, or a reaction added or taken back. The app replaces the message that has the same `message_id`. The message's `seq` is the change number when it was posted, and its `updated_seq` is the change number of its latest change. Here Meher has just put a thumbs-up on Arjun's message, so `updated_seq` moved from 48 to 49.

```json
{
  "type": "message",
  "trip_id": "t_goa",
  "message": {
    "message_id": "m_0124",
    "seq": 48,
    "updated_seq": 49,
    "author": { "kind": "person", "person_id": "p_arjun" },
    "text": "Yes, North. It's closer to the airport for my late flight too.",
    "attachments": [],
    "mentions_go": false,
    "mentions": [],
    "reactions": [{ "emoji": "👍", "person_id": "p_meher" }],
    "withheld": false,
    "deleted": false,
    "sent_at": "2026-10-05T04:11:00Z"
  }
}
```

Go's reactions travel the same way. When Go reacts to a message (Go's `add_reaction` request), the server stores the reaction with no person, takes a change number, and sends the message again. Go's reaction is the one without a `person_id`. Here Go has put a quiet ✅ on Priya's message after it noted "North Goa, not South" in the trip record, so the message changed at change 53:

```json
{
  "type": "message",
  "trip_id": "t_goa",
  "message": {
    "message_id": "m_0122",
    "seq": 47,
    "updated_seq": 53,
    "author": { "kind": "person", "person_id": "p_priya" },
    "text": "Let's do North Goa, not South. Better beaches for us.",
    "attachments": [],
    "mentions_go": false,
    "mentions": [],
    "reactions": [
      { "emoji": "👍", "person_id": "p_rahul" },
      { "emoji": "✅", "person_id": null }
    ],
    "withheld": false,
    "deleted": false,
    "sent_at": "2026-10-05T04:08:00Z"
  }
}
```

**A card updated in place.** When Go replaces one of its cards with a `replace_card` request, the server stores the new card (`raw.card`, exactly as it arrived, see [Cards](06-cards.md)) on the same message and sends it. The app swaps the card and leaves the message where it is. This is how a live call, a working task, or a pay card moving to paid changes on screen.

```json
{
  "type": "card",
  "trip_id": "t_goa",
  "message_id": "m_0174",
  "card": {
    "card_id": "c_villa_call",
    "kind": "call",
    "fallback_text": "Go is calling Villa Sol to ask if Arjun can check in at 11 pm.",
    "call_id": "call_01",
    "business": "Villa Sol",
    "goal": "Ask if Arjun can check in at 11 pm",
    "state": "talking",
    "started_at": "2026-10-06T10:31:05Z",
    "last_line": { "who": "them", "text": "Late check-in is fine, the caretaker can wait for him." },
    "actions": [{ "action_id": "stop", "label": "Stop the call", "style": "secondary" }]
  }
}
```

**Someone is typing.** One kind of message covers Go and people, and `who` says who is typing. When Go sends the `typing` notification on the socket, the server sends this to everyone in the room. Show "Go is typing..." until `until` passes (10 seconds after the server got the notification) or Go's next message lands, whichever comes first. Go repeats the notification every 5 seconds while it works, so the line stays up during a long job. `"on": false` hides it at once.

```json
{ "type": "typing", "trip_id": "t_goa", "who": { "kind": "go" }, "on": true, "until": "2026-10-05T06:49:12Z" }
```

This is the `typing` notification Go sent for it. It has no answer:

<!-- schema: GoTyping -->
```json
{ "trip_id": "t_goa", "on": true }
```

People's typing is between the app and the server only. If you show it, use the same kind of message with `"who": { "kind": "person", "person_id": "p_priya" }`, and decide yourselves how often the app sends it and when a person's line runs out. The server does not send people's typing to go-brain. Go does not need it: after a message for Go, Go waits about 2 seconds in case the same person sends more, and checks for anything new just before it answers (see [Events](03-events.md)).

**The trip changed.** Send this for every change to the trip that is not a message: a vote cast or closed, a mandate, a trip record line added or undone, a booking, an expense, someone joining or leaving. It carries the trip's new change number. When `seq` is higher than the one the app holds, the app reads what it is showing again from the server. Record cards in the room, such as a vote's tally or a ticket, redraw from that fresh data.

```json
{ "type": "trip_changed", "trip_id": "t_goa", "seq": 88 }
```

Good to know:
- The server already writes one event per change for go-brain (see [Events](03-events.md)). Sending the app's message from the same place, after the change is committed, keeps the app and go-brain in step.
- Keep the highest change number the app has seen: a message's `updated_seq`, or the `seq` of a "trip changed" message. After a reconnect, or when the number jumps by more than one, read the messages and the trip from the server again before trusting the socket. Sockets drop and phones sleep.
- Typing and card updates carry no `seq`, because they are not changes to the trip. A reaction, Go's included, is a change: it moves the message's `updated_seq`.
- Show a person's own message straight away as "sending", then replace it when the server sends it back with its `message_id` and `seq`.
- `withheld` is only for go-brain. When a person pauses Go, the rest of the room still sees their messages in full, so the server always sends the app the text.

## Drawing Go's messages

Go's messages are how Go shows up as a member of the room, so draw them the way you draw a friend's message, with Go's own look. Use these rules for every message whose author is `{ "kind": "go" }`.

- Draw Go as the ceramic character, with the name "Go". Never give Go a person's photo, initials or colour, and never give a person Go's look, so nobody mistakes Go for a person or a person for Go.
- Show Go's text like any message, and Go's card under the text, in the same message.
- Go's messages can reply to a message (`reply_to`) and name people (`mentions`), just like a person's.
- Go's reactions look like anyone's reaction, from Go. A reaction without a `person_id` is Go's: count it with the others, and where the app shows who reacted, show Go's character and the name "Go".

Here is Go's answer to Priya's question about flights, exactly as the server stores it and sends it to the app:

<!-- schema: Message -->
```json
{
"message_id": "m_0133",
"seq": 58,
"updated_seq": 58,
"author": { "kind": "go" },
"text": "Priya, here are three Friday evening flights from Delhi, all under ₹6k.",
"attachments": [],
"reply_to": "m_0132",
"about_message_id": null,
"mentions_go": false,
"mentions": ["p_priya"],
"reactions": [],
"card": {
  "kind": "options",
  "card_id": "c_flights_1",
  "fallback_text": "3 flights from Delhi to Goa on Fri 6 Nov, from ₹5,640 per person",
  "title": "Friday flights, Delhi to Goa",
  "option_kind": "flight",
  "checked_at": "2026-10-05T06:49:30Z",
  "options": [
    {
      "option_id": "opt_flight_1",
      "title": "IndiGo 6E 2134",
      "subtitle": "6:10 pm to 8:45 pm, non-stop",
      "price_minor": 592000,
      "currency": "INR",
      "price_note": "per person",
      "highlights": ["Non-stop", "Lands 8:45 pm"],
      "journey": {
        "mode": "flight",
        "origin": { "name": "Delhi", "code": "DEL" },
        "destination": { "name": "Goa", "code": "GOI" },
        "depart_at": "2026-11-06T18:10:00+05:30",
        "arrive_at": "2026-11-06T20:45:00+05:30",
        "carrier_name": "IndiGo",
        "carrier_code": "6E",
        "number": "6E 2134",
        "stops": 0
      }
    },
    {
      "option_id": "opt_flight_2",
      "title": "Air India, 7:45 pm",
      "subtitle": "7:45 pm to 10:20 pm, non-stop",
      "price_minor": 598000,
      "currency": "INR",
      "price_note": "per person",
      "highlights": ["Non-stop"],
      "journey": {
        "mode": "flight",
        "origin": { "name": "Delhi", "code": "DEL" },
        "destination": { "name": "Goa", "code": "GOI" },
        "depart_at": "2026-11-06T19:45:00+05:30",
        "arrive_at": "2026-11-06T22:20:00+05:30",
        "carrier_name": "Air India",
        "carrier_code": "AI",
        "stops": 0
      }
    },
    {
      "option_id": "opt_flight_3",
      "title": "IndiGo, 9:20 pm",
      "subtitle": "9:20 pm to 11:55 pm, non-stop",
      "price_minor": 564000,
      "currency": "INR",
      "price_note": "per person",
      "highlights": ["Cheapest", "Lands late"],
      "journey": {
        "mode": "flight",
        "origin": { "name": "Delhi", "code": "DEL" },
        "destination": { "name": "Goa", "code": "GOI" },
        "depart_at": "2026-11-06T21:20:00+05:30",
        "arrive_at": "2026-11-06T23:55:00+05:30",
        "carrier_name": "IndiGo",
        "carrier_code": "6E",
        "stops": 0
      }
    }
  ],
  "actions": [
    { "action_id": "pick", "label": "I'll take this", "style": "primary", "per_option": true },
    { "action_id": "vote", "label": "Put it to a vote", "style": "secondary" }
  ]
},
"withheld": false,
"deleted": false,
"edited_at": null,
"sent_at": "2026-10-05T06:49:40Z"
}
```

Cards come in two families, and the app draws them differently. [Cards](06-cards.md) describes every kind and its fields.

| Family | Kinds | What the card carries | Where the app gets what it shows | Who owns the buttons |
|---|---|---|---|---|
| Record cards | `vote`, `mandate`, `ticket`, `expense`, `settle_up`, `day`, `plan`, `budget` | An id, such as `decision_id` or `booking_id` | The server's own rows, so the room and the Trip screens always agree | server |
| Go cards | `options`, `working`, `call`, `pay`, `notice` | Everything to show, plus `actions` | The card itself | go-brain, through the server (see [Buttons on Go cards](#buttons-on-go-cards)) |

Good to know:
- When the app does not know a card's `kind`, it shows the card's `fallback_text` as plain text. An older app build stays usable after Go learns a new kind of card.
- Show a button only to the people in its `only_for_person_ids`. When the list is absent, everyone sees the button. On an options card, a button with `per_option: true` appears on every option.
- An options card says when Go checked the prices, from `checked_at`, such as "checked 3 min ago".
- The mandate card's "Yes, book it" and "Not now" buttons are the server's own, shown to the payer only. See [Money and the vault](08-money-and-the-vault.md).

## Buttons on Go cards

A tap on a Go card's button goes from the app to the server, which asks go-brain what to do and passes the answer back. Use this for every button in a Go card's `actions`. Buttons on record cards (voting, "Yes, book it", settling up) belong to the server and never reach go-brain this way.

1. The app sends the server the card, the `action_id`, the `option_id` when the button was on one option, and its own id for this press.
2. The server checks that the person is in the trip and gives the tap a `tap_id`. It uses the app's id for the press when there is one, so that a double tap that gets through is still one tap, and otherwise makes a new id.
3. The server sends go-brain a `card_tap` request on the socket with the `tap_id`, the trip, the card, the `action_id`, the person's id and, when there is one, the `option_id`. go-brain acts on each `tap_id` once, even if the tap arrives twice.
4. go-brain answers within 3 seconds with one of three results, and the server passes it back to the app:
   - `done`: show the toast, if there is one. Go follows up in the room.
   - `open`: open the URL in the system browser sheet (see the next section).
   - `refused`: show the toast.

When Rahul taps Approve on the pay card for the villa, the server sends go-brain this `card_tap`:

<!-- schema: CardTap -->
```json
{ "tap_id": "tap_0457", "trip_id": "t_goa", "card_id": "c_villa_pay", "action_id": "approve", "person_id": "p_rahul" }
```

and go-brain answers with the vault page to open:

<!-- schema: ActionOpen -->
```json
{ "result": "open", "url": "https://brain.go.example/vault/approve?link=lk_4Rt8Zp2Lq", "expires_at": "2026-10-05T09:06:30Z" }
```

Here is the server side. `brain` is the one `BrainSocket` that the server keeps open to go-brain (see [The socket](02-the-socket.md)), and the other snippets on this page use it too. The `/app/...` paths are examples: the app's API is yours to design.

**TypeScript**

```ts
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { CardActionResult, CardTap } from '@go/contract';
import { brain } from './brain.js'; // the one BrainSocket the server keeps open, from The socket
import { signedInPerson } from './auth.js'; // your own session check

const app = Fastify();

app.post<{ Params: { tripId: string; cardId: string }; Body: { action_id: string; option_id?: string; press_id?: string } }>(
  '/app/trips/:tripId/cards/:cardId/actions',
  async (req, reply) => {
    const personId = await signedInPerson(req); // also check they are in this trip
    const tap = CardTap.safeParse({
      tap_id: req.body.press_id ?? `tap_${randomUUID()}`, // the app's id for the press, so a double tap is one tap
      trip_id: req.params.tripId,
      card_id: req.params.cardId,
      action_id: req.body.action_id,
      option_id: req.body.option_id,
      person_id: personId,
    });
    if (!tap.success) return reply.code(422).send({ error: 'not a tap on a Go card' });
    try {
      return CardActionResult.parse(await brain.request('card_tap', tap.data, { timeoutMs: 3_500 })); // 3 s plus the network
    } catch {
      return { result: 'refused', toast: "Go didn't answer. Try again." };
    }
  },
);
```

**Python**

```python
import asyncio
import uuid

from fastapi import Depends, FastAPI
from go_contract import METHODS
from pydantic import BaseModel, Field

from auth import signed_in_person  # your own session check
from brain import brain  # the one BrainSocket the server keeps open, from The socket
from brain_socket import SocketCallError

app = FastAPI()
CARD_TAP = METHODS["card_tap"]


class Tap(BaseModel):  # FastAPI answers 422 when the app sends something else
    action_id: str = Field(pattern=r"^[a-z][a-z_]{0,31}$")
    option_id: str | None = Field(default=None, min_length=1, max_length=64)
    press_id: str | None = Field(default=None, min_length=1, max_length=64)  # the app's id for this press


@app.post("/app/trips/{trip_id}/cards/{card_id}/actions")
async def tap_card(trip_id: str, card_id: str, tap: Tap, person_id: str = Depends(signed_in_person)):
    # also check the person is in this trip
    params = CARD_TAP.params.model_validate({
        "tap_id": tap.press_id or f"tap_{uuid.uuid4().hex}",  # a double tap with the same press id is one tap
        "trip_id": trip_id,
        "card_id": card_id,
        "action_id": tap.action_id,
        "option_id": tap.option_id,
        "person_id": person_id,
    })
    try:
        answer = await brain.request("card_tap", params.model_dump(mode="json", exclude_none=True), timeout=3.5)  # 3 s plus the network
    except (SocketCallError, asyncio.TimeoutError):
        return {"result": "refused", "toast": "Go didn't answer. Try again."}
    return CARD_TAP.result.model_validate(answer).root
```

Good to know:
- Disable the button while the tap is on its way, so a double tap sends one request. Also give each press its own id (a new UUID) and send it with the tap, so a double tap that still gets through reaches Go as one `tap_id`.
- Do not retry a tap on your own. The first one may already have started something. If the person taps again after a toast, that is a new press with a new id.
- The `tap_id` only stops a tap from being acted on twice. go-brain still checks who tapped, from `person_id`, which the server takes from the signed-in session.
- go-brain checks `only_for_person_ids` too, and answers `refused` to anyone else, but hiding the button is what keeps the room clear.

## Opening go-brain pages

go-brain's pages, the vault and watching Go work, open in the system browser sheet from a link that the server hands the app. Use this whenever a card action answers `open`, and when the person opens their vault from the You screen.

- Open the link with Flutter's `url_launcher` in `LaunchMode.inAppBrowserView`. On iOS that is SFSafariViewController and on Android it is Chrome Custom Tabs. The page slides up over the app and the person returns with one tap.
- Never open these pages in `webview_flutter`. Passkeys (Face ID) do not work inside a plain WebView, so the vault could not ask the payer for Face ID and the payment could not happen. The system sheet supports passkeys and also shows the page's real address, so the person can see it is go-brain's page.
- Links expire 5 minutes after they are made (`expires_at`). Ask the server for a link only when the person taps, and open it straight away. Never fetch links ahead of time, keep them for later, or put them in a push.

**Dart**

```dart
import 'package:url_launcher/url_launcher.dart';

/// Handles the server's answer to a tap on a Go card button.
Future<void> handleCardAction(Map<String, dynamic> answer, void Function(String) showToast) async {
  switch (answer['result']) {
    case 'open':
      final opened = await launchUrl(
        Uri.parse(answer['url'] as String),
        mode: LaunchMode.inAppBrowserView, // SFSafariViewController on iOS, Chrome Custom Tabs on Android
      );
      if (!opened) showToast('Could not open the page. Try again.');
    case 'done':
    case 'refused':
      final toast = answer['toast'] as String?;
      if (toast != null) showToast(toast);
  }
}
```

When the sheet closes, the app does nothing special. Whatever happened on the page reaches the room the normal way. For example, after Rahul pays, Go updates the pay card to paid and the app gets that as a card update on the live connection.

Good to know:
- A link is made for the person who tapped. It is not for sharing.
- The vault link on the You screen comes from go-brain's answer to a `vault_link` request, which the server sends for the person (see the code in [Pausing Go, "what Go knows about you" and "forget me"](#pausing-go-what-go-knows-about-you-and-forget-me)).

## The "needs you" strip

The "needs you" strip is a short list, pinned above the room, of what this person has to do in this trip. It is different for each person, and the server works it out from its own rows. It makes sure a vote or a payment never gets lost in a busy chat.

| What | Shows for | Leaves the strip when | A tap opens |
|---|---|---|---|
| An open vote | Each person who has not voted in it | They vote, or the vote closes or is cancelled | The vote card in the room |
| A mandate waiting for its payer | The payer, while the mandate has neither `confirmed_at` nor `declined_at` | The payer taps "Yes, book it" or "Not now". A new mandate clears both, so it shows again. | The mandate card |
| A Go card that names them | The people in the card's `for_person_ids` | Go removes them from `for_person_ids` with `replace_card`, once it is settled | The card in the room |
| An open line in the trip record that asks them | The people in the line's `person_ids`, while the line is `open` and `active` | The line is done or undone, or becomes agreed or doing | The trip record at that line |

Good to know:
- The server knows who has voted even in an anonymous vote, because it stores the votes. Only the totals are hidden, from everyone including Go.
- A pay card waiting for Rahul shows in his strip through `for_person_ids`. When Go updates it to paid, the `replace_card` removes him and the item goes.

## Pushes

The server sends a push notification only when someone needs to look now. Never push for every message: in a busy group chat, that would bury the pushes that matter.

| When | Who gets the push | Push text |
|---|---|---|
| Go names people in a message (the `mentions` on Go's message) | Those people | Go's text |
| Go posts a new card with `for_person_ids` | Those people | The card's `fallback_text` |
| A vote is about to close | The people who have not voted | The question and when it closes, such as "Where do we stay? closes in 1 hour" |
| Someone owes money (from `money.transfers` in the trip) | The person who owes | Who and how much, such as "You owe Kabir ₹680 for the airport cab" |

Good to know:
- Put `trip_id` and `message_id` in the push data, so a tap opens the room at that message.
- A `replace_card` that updates a card is not a new card, so it sends no push.
- Every card's `fallback_text` is written to work as push text on its own.

## Catch-up

Catch-up tells one person, in a few lines, what happened while they were away. The server asks go-brain for it when someone opens the room after a while, and the app shows it above the room for that person only. It is never posted in the room.

We suggest asking when the person has been away for 3 hours or more, or has 15 or more unread messages. The server sends go-brain a `catch_up` request with the trip, the person and the time they last looked at the room:

<!-- schema: CatchUpRequest -->
```json
{ "trip_id": "t_goa", "person_id": "p_meher", "since": "2026-10-05T03:30:00Z" }
```

go-brain answers within 3 seconds:

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

Draw `summary` as one line in Go's voice, then the items, at most five. A tap on an item with a `message_id` scrolls the room to that message. When `summary` is null and there are no items, show nothing.

**TypeScript**

```ts
import { CatchUp } from '@go/contract';
import { brain } from './brain.js'; // the one BrainSocket the server keeps open, from The socket

const AWAY_MS = 3 * 60 * 60 * 1000;

/** What a person missed, or null when they were not away long or go-brain did not answer. */
export async function catchUpFor(tripId: string, personId: string, lastSeenAt: Date, unread: number) {
  if (Date.now() - lastSeenAt.getTime() < AWAY_MS && unread < 15) return null;
  try {
    const params = { trip_id: tripId, person_id: personId, since: lastSeenAt.toISOString() };
    return CatchUp.parse(await brain.request('catch_up', params, { timeoutMs: 3_500 })); // 3 s plus the network
  } catch {
    return null; // show the room without it
  }
}
```

**Python**

```python
import asyncio
from datetime import datetime, timedelta, timezone

from go_contract import models

from brain import brain  # the one BrainSocket the server keeps open, from The socket
from brain_socket import SocketCallError

AWAY = timedelta(hours=3)


async def catch_up_for(trip_id: str, person_id: str, last_seen_at: datetime, unread: int) -> models.CatchUp | None:
    """What a person missed, or None when they were not away long or go-brain did not answer."""
    if datetime.now(timezone.utc) - last_seen_at < AWAY and unread < 15:
        return None
    params = {"trip_id": trip_id, "person_id": person_id, "since": last_seen_at.isoformat()}
    try:
        answer = await brain.request("catch_up", params, timeout=3.5)  # 3 s plus the network
    except (SocketCallError, asyncio.TimeoutError):
        return None  # show the room without it
    return models.CatchUp.model_validate(answer)
```

Good to know:
- Never hold the room back for catch-up. Show the room at once and slide the catch-up in when it arrives. If go-brain fails or takes longer than 3 seconds, skip it.
- Let the person dismiss it with a tap.

## "Ask Go about this"

"Ask Go about this" lets a person point Go at one message and ask about it. It lives in the long-press menu of every message, including Go's own cards.

1. The person long-presses a message and picks "Ask Go about this".
2. The app opens the message box with that message quoted above it, and the person types their question.
3. The app sends the new message with `about_message_id` set to the message they long-pressed.
4. The server stores it with `mentions_go: true`, even when the text does not name Go, so Go answers it.

Kabir long-pressed Go's flight options and asked this:

<!-- schema: Message -->
```json
{
  "message_id": "m_0135",
  "seq": 60,
  "updated_seq": 60,
  "author": { "kind": "person", "person_id": "p_kabir" },
  "text": "Anything cheaper on Saturday morning?",
  "attachments": [],
  "about_message_id": "m_0133",
  "mentions_go": true,
  "mentions": [],
  "reactions": [],
  "withheld": false,
  "deleted": false,
  "sent_at": "2026-10-05T06:52:30Z"
}
```

Good to know:
- `about_message_id` is not the same as `reply_to`. A reply is part of the conversation. "Ask Go about this" asks Go about the message, and the room sees the question with the message quoted.

## Pausing Go, "what Go knows about you" and "forget me"

These controls on the You screen let each person decide what Go sees and keeps about them. The app calls the server for all of them. The server checks who is signed in and then sends go-brain a request on the socket for that person. The app never talks to go-brain directly.

| Control | What the server does | Request to go-brain |
|---|---|---|
| Pause Go in this trip | Sets `go_paused` on the person and sends a `person.updated` event with `changed: ["go_paused"]`. While Go is paused, the person's messages still reach go-brain as `message.created`, with `withheld: true` and no text or attachments. | None: go-brain learns it from the event |
| What Go knows about you | Shows the person's facts, each with its topic, its trip and where it came from | `get_person` |
| Delete one fact | Removes one fact from the list | `delete_fact` |
| Remember me in my next trips (carry-over, off by default) | Turns carry-over on or off | `update_person` |
| Forget me in this trip | Deletes what Go learned about the person in this trip | `forget_person` with `trip_id` |
| Forget me everywhere | Deletes what Go learned about the person in every trip | `forget_person` without `trip_id` |
| My vault | Gets a vault link and opens it in the system browser sheet | `vault_link` |

"Forget me" deletes the person's facts in go-brain and checks that none are left, so the answer always has `remaining_facts: 0`. The server then clears the person's join answers (`from_city`, `earliest_leave`, `know`) in the same trips and sends `person.updated`, so Go cannot learn them again. Show the person how many things were forgotten. The room's messages stay, because the rest of the group can still see them.

On "What Go knows about you", show each fact so the person can trust it: its text, its topic, and where it came from. A fact with a `message_id` opens that message when tapped. A fact without one came from the person's join answers.

**TypeScript**

```ts
import Fastify from 'fastify';
import { ForgetResult, Link, PersonPage } from '@go/contract';
import { brain } from './brain.js'; // the one BrainSocket the server keeps open, from The socket
import { signedInPerson } from './auth.js'; // your own session check

const app = Fastify();
const TWO_SECONDS = { timeoutMs: 2000 };

// What Go knows about you
app.get('/app/me/go', async (req) => {
  const me = await signedInPerson(req);
  return PersonPage.parse(await brain.request('get_person', { person_id: me }, TWO_SECONDS));
});

// Forget me: in one trip with ?trip_id=t_goa, or everywhere without it
app.delete<{ Querystring: { trip_id?: string } }>('/app/me/go', async (req) => {
  const me = await signedInPerson(req);
  const params = req.query.trip_id ? { person_id: me, trip_id: req.query.trip_id } : { person_id: me };
  return ForgetResult.parse(await brain.request('forget_person', params, TWO_SECONDS));
});

// My vault: ask only when the person taps, because the link expires after 5 minutes
app.post<{ Body: { start?: 'home' | 'add_card' | 'add_login' } }>('/app/me/vault-link', async (req) => {
  const me = await signedInPerson(req);
  const params = { kind: 'vault', person_id: me, start: req.body?.start ?? 'home' };
  return Link.parse(await brain.request('vault_link', params, TWO_SECONDS));
});
```

**Python**

```python
from typing import Literal

from fastapi import Depends, FastAPI
from go_contract import models
from pydantic import BaseModel

from auth import signed_in_person  # your own session check
from brain import brain  # the one BrainSocket the server keeps open, from The socket

app = FastAPI()


@app.get("/app/me/go")
async def what_go_knows(me: str = Depends(signed_in_person)) -> models.PersonPage:
    answer = await brain.request("get_person", {"person_id": me}, timeout=2.0)
    return models.PersonPage.model_validate(answer)


@app.delete("/app/me/go")
async def forget_me(trip_id: str | None = None, me: str = Depends(signed_in_person)) -> models.ForgetResult:
    params = {"person_id": me, "trip_id": trip_id} if trip_id else {"person_id": me}
    answer = await brain.request("forget_person", params, timeout=2.0)
    return models.ForgetResult.model_validate(answer)


class VaultLinkAsk(BaseModel):
    start: Literal["home", "add_card", "add_login"] = "home"


@app.post("/app/me/vault-link")
async def vault_link(ask: VaultLinkAsk, me: str = Depends(signed_in_person)) -> models.Link:
    answer = await brain.request("vault_link", {"kind": "vault", "person_id": me, "start": ask.start}, timeout=2.0)
    return models.Link.model_validate(answer)
```

Deleting one fact (`delete_fact`) and turning carry-over on or off (`update_person`) follow the same pattern. [Your requests](05-your-requests.md) has every request's params and result.

Good to know:
- Take `person_id` from the signed-in session, never from the request. Nobody can read or delete someone else's facts.
- While Go is paused, tell the person plainly, for example under the message box: "Go can't see your messages in this trip."
- Apart from the join answers, forget me does not change what the server holds. The person's messages, votes, bookings and expenses belong to the trip, which the rest of the group can see.
