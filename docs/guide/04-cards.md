# Cards

A card is something richer than text that Go posts in the room inside one of its messages: a vote, flights with prices, a ticket, a live phone call, a payment to approve. This page describes all 13 kinds of card, what the app draws for each one, and its buttons. The app team needs it to draw cards, and the go-server team needs it to store cards, draw record cards from its own rows, and handle their buttons.

| Kind | Family | What it shows |
|---|---|---|
| `vote` | Record card | A vote, with its options, the tally and the vote buttons |
| `mandate` | Record card | What the group allowed for a spend, with "Yes, book it" for the payer |
| `ticket` | Record card | A booking, drawn as a boarding pass, a stay pass or a table reservation |
| `expense` | Record card | One expense: who paid, how much, split between whom |
| `settle_up` | Record card | Who pays whom right now, each with a UPI button |
| `day` | Record card | One day of the itinerary |
| `plan` | Record card | The whole itinerary, day by day |
| `budget` | Record card | What was spent against the plan, by category |
| `options` | Go card | Options Go found (stays, flights, places), with prices and when they were checked |
| `working` | Go card | Go doing a longer job, step by step, with a Watch button |
| `call` | Go card | Go on a phone call to a business, live, then its outcome and transcript |
| `pay` | Go card | A payment waiting for the payer, with Approve for the payer |
| `notice` | Go card | "Good to know" with its source, or a "Heads up" about a deadline, a price change or a clash |

## How a card travels

Go posts a card as the `card` of one of its messages, with `postMessage` (see [The trip API](03-trip-api.md#postmessage-post-gos-message-in-the-room)). The same JSON travels unchanged from go-brain through go-server to the app. go-server stores the card on the message exactly as it arrived and sends it to the app the same way. It never rewrites a card, so a field added to a card later in version 1 reaches the app without any change in go-server. The card also comes back to go-brain inside the `message.created` event, like every other message.

## Two families of cards

Every card belongs to one of two families. The family decides where the app gets what it draws and who handles the buttons.

| | Record cards | Go cards |
|---|---|---|
| Kinds | `vote`, `mandate`, `ticket`, `expense`, `settle_up`, `day`, `plan`, `budget` | `options`, `working`, `call`, `pay`, `notice` |
| What the card carries | Its kind and an id (such as `decision_id` or `booking_id`), plus the fields every card has | Everything to show, plus its buttons in `actions` |
| What the app draws from | go-server's own rows: the vote, the booking, the expense, the trip's money and itinerary | The card itself |
| Who handles the buttons | go-server | go-brain, through go-server |
| How it changes | It always shows the row as it is now. When a vote comes in, the vote card in the room shows the new tally without a new message. | Go replaces it in place with a `PUT`. |

Record cards are drawn from go-server's rows so that the room and the Trip screens never disagree. A ticket in the room and the same booking on the Trip screen are the same row.

## Fields every card has

Every card, in both families, has these fields.

| Field | What it is | What go-server does with it |
|---|---|---|
| `card_id` | Go's id for the card, unique within the trip's room. | Stores it with the message. `putCard` finds the card by this id. |
| `kind` | One of the 13 kinds on this page. | Nothing. The app uses it to choose how to draw the card. |
| `fallback_text` | Plain words that say what the card says, 1 to 300 characters. | Uses it as the push text when it pushes the card's `for_person_ids`. |
| `for_person_ids` | The people who need to act on the card, if any. | Pushes each of them when the card is new, and pins the card in their "needs you" strip while their id stays in the list. |

Go removes people from `for_person_ids` with a `PUT` once they have nothing left to do, which takes the card out of their strip. [The app](06-the-app.md#the-needs-you-strip) explains the strip.

Good to know:
- Go leaves `for_person_ids` out of vote and mandate cards. go-server already pins an open vote for everyone who has not voted, and a mandate for its payer until they answer, from its own rows.
- Write `fallback_text` so it works on its own as a push: who, what, and what to do.

## Buttons on Go cards

Go cards carry their buttons in `actions`, at most three per card. A tap goes from the app to go-server, which passes it to go-brain's card action call and returns go-brain's answer to the app. Buttons on record cards never reach go-brain: go-server handles them itself.

| Field | What it is |
|---|---|
| `action_id` | What the button does, as lowercase words joined by underscores, up to 32 characters, such as `watch` or `pick`. Sent back with the tap. |
| `label` | The button's text, 1 to 24 characters. |
| `style` | `primary` (the main button, filled) or `secondary` (outlined). |
| `only_for_person_ids` | Only these people see the button. When it is absent, everyone sees it. |
| `per_option` | Only on an options card: show the button on every option, and send that option's `option_id` with the tap. |

When someone taps a button:

1. The app sends go-server the card, the `action_id`, and the `option_id` when the button was on one option.
2. go-server calls `POST /v1/trips/{trip_id}/cards/{card_id}/actions` on go-brain with the person's id.
3. go-brain answers within 3 seconds with one of three results, and go-server passes it to the app:
   - `done`: show the `toast`, if there is one. Go follows up in the room, or updates the card in place.
   - `open`: open the `url` straight away in the system browser sheet, never in a WebView. This is how the vault page and the page for watching Go work open.
   - `refused`: show the `toast`. Nothing changed.

[The brain API](05-brain-api.md#card-actions) describes this call in full, and [The app](06-the-app.md#buttons-on-go-cards) shows how the app opens links.

These are the buttons Go usually puts on its cards:

| Card | `action_id` | Usual label | Who sees it | What the tap does |
|---|---|---|---|---|
| `options` | `pick` (with `per_option`) | "I'll take this" | Everyone | Picks that option. Go follows up in the room. |
| `options` | `vote` | "Put it to a vote" | Everyone | Go opens a vote on these options. |
| `working` | `watch` | "Watch" | Everyone | Opens a page where the person watches Go work. |
| `working` | `stop` | "Stop" | Everyone | Stops the job. |
| `call` | `stop` | "Stop the call" | Everyone | Ends the call. |
| `pay` | `approve` | "Approve" | The payer only | Opens the vault page, where the payer confirms with Face ID. |
| `pay` | `decline` | "Decline" | The payer only | Declines the payment. |

Good to know:
- Disable a button while its tap is on the way, so a double tap sends one request.
- go-brain still checks who may use a button. It refuses an `approve` from anyone but the payer, even though the app shows that button only to the payer.

## Updating a card in place

Go updates a card by sending the whole new card with the same `card_id` to `PUT /brain/v1/trips/{trip_id}/cards/{card_id}`. go-server swaps the card on its message and sends the new version to the app over the live connection. The app replaces the card and leaves the message where it is in the room.

Go updates a live call as it moves from dialing to talking to ended, a working task as its steps finish, and a pay card as it moves to paid. It also uses a `PUT` to take people out of `for_person_ids`. A card update is not a change to the trip: it takes no change number, sends no event and sends no push. [The trip API](03-trip-api.md#putcard-replace-a-card-in-place) has the rules.

## Images

Every image on a card (`image_url`, `logo_url`, `screenshot_url` and a place's `photo_url`) is an `https` URL served from go-brain's image cache, such as `https://brain.go.example/img/villa-sol.jpg`. An image URL never changes what it shows, so the app can cache it for the life of the trip. A new screenshot of Go's work always has a new URL.

People's photos are not on cards. They come from go-server, on each person (`https://cdn.go.example/people/p_rahul.jpg`).

## A card kind the app does not know

When the app gets a card whose `kind` it does not know, it shows the card's `fallback_text` as plain text in Go's message, with no buttons. An older app build stays usable after Go learns a new kind of card. Do the same when a record card's row cannot be found, for example because the app has not loaded it yet.

## Category colours

The itinerary, expenses and the budget share one set of spending categories. Draw them in the same colours everywhere.

| `category` | Colour |
|---|---|
| `stay` | Blue |
| `food` | Orange |
| `getting_around` | Green |
| `activities` | Yellow |
| `other` | The contract gives none. Use the app's neutral grey. |

## Record cards

go-server draws these eight kinds from its own rows. The card carries only the id of the row, so the examples are short.

### Vote

A vote card shows a vote and lets people vote on it. Go posts one right after it opens a vote, with `postMessage`.

go-server draws it from the vote's row:
- The question at the top, and when it closes ("Closes at 6 pm", or "Closes in 2 h" near the end).
- One row per option, with its photo (`image_url`) when there is one, its label, its price with the currency when there is one, and its note.
- Under each option, a bar for its share of the tally, and the faces of the people who voted for it.
- How many have voted: "4 of 5 voted".

For an anonymous vote, show the totals only, never faces, to anyone. When the vote closes, highlight the winner with the result ("Villa Sol won, 4 to 1") and remove the vote buttons. When it was called off, show it greyed out as "Called off".

**Buttons.** Each option is a vote button, owned by go-server. A tap records the person's vote (a tap on another option changes it), and go-server sends `decision.voted`. The buttons go away when the vote closes or is called off.

<!-- schema: VoteCard -->
```json
{
  "card_id": "c_villa_vote",
  "kind": "vote",
  "decision_id": "d_villa",
  "fallback_text": "Vote: Where do we stay? Villa Sol ₹54,200, Casa Azul ₹61,800 or The Palms ₹58,500, for 3 nights. Open Go to vote."
}
```

### Mandate

A mandate card shows what the group allowed for a spend after a vote, and asks the payer to say yes. Go posts it with the vote's result, right after it sets the mandate.

go-server draws it from the vote's mandate:
- The chosen option (`options[choice_index]`), with its photo and label: "Villa Sol".
- The cap: "Up to ₹55,000".
- "Refundable only", when `refundable_only` is true.
- Who pays, with their face: "Rahul pays".

**Buttons.** "Yes, book it" (primary) and "Not now" (secondary), shown to the payer only and owned by go-server, because they are part of the spend check. Everyone else sees "Waiting for Rahul" instead. When the payer taps one, go-server records `confirmed_at` or `declined_at` and sends `mandate.confirmed` or `mandate.declined`. After the answer, the card shows it ("Rahul said yes") in place of the buttons. When Go sets a new mandate on the same vote, both answers are cleared and the buttons come back. [Money and the vault](07-money-and-the-vault.md) explains the whole payment.

<!-- schema: MandateCard -->
```json
{
  "card_id": "c_villa_mandate",
  "kind": "mandate",
  "decision_id": "d_villa",
  "fallback_text": "Ready to book Villa Sol: up to ₹55,000, refundable only, Rahul pays. Rahul, open Go to say yes."
}
```

### Ticket

A ticket card shows a booking. Go posts one after it records a booking, and the same card works for bookings people add themselves.

go-server draws it from the booking's row, in one of three shapes depending on the booking's `kind`:

| `kind` | Drawn as | What it shows |
|---|---|---|
| `flight`, `train`, `bus` | A boarding pass | From and to (`journey.origin` and `journey.destination`, with their codes in large type), the departure and arrival times, the carrier's name and logo, the flight or train number, and `ref` as the PNR |
| `stay` | A stay pass | The photo (`image_url`, or the place's `photo_url`), the title, the place's name and address, check-in (`starts_at`) and check-out (`ends_at`), the number of nights, and `ref` |
| `table` | A table reservation | The place, the date and time (`starts_at`), the party size (how many people are in `for_person_ids`), and `ref` |
| `cab`, `activity`, `other` | A simple ticket | The title, the vendor, the time (`starts_at`), and `ref` |

Every ticket also shows who it is for (their faces), the amount and who paid ("Rahul paid ₹54,200"), and "Free cancellation until Sun 1 Nov, 11:59 pm" when `refundable_until` is set and still ahead. A cancelled booking is drawn with a "Cancelled" stamp. Show times with the offset they carry, which is local time at the place.

**Buttons.** The contract asks for none. go-server may add its own, such as opening the booking on the Trip screens.

<!-- schema: TicketCard -->
```json
{
  "card_id": "c_villa_ticket",
  "kind": "ticket",
  "booking_id": "b_villa",
  "fallback_text": "Booked: Villa Sol, 3 nights, Fri 6 to Mon 9 Nov. Ref IXG-7Q2K9. Free cancellation until 1 Nov."
}
```

### Expense

An expense card shows one thing someone paid for and how it is split. Go posts one when someone asks about an expense, such as Meher asking what she owes for the cab.

go-server draws it from the expense's row: the note ("Airport cab") with a dot in the category's colour, the amount and who paid ("Kabir paid ₹3,400"), the faces of the people it is split between, and each person's share ("₹680 each").

**Buttons.** The contract asks for none.

<!-- schema: ExpenseCard -->
```json
{
  "card_id": "c_cab_expense",
  "kind": "expense",
  "expense_id": "e_cab",
  "fallback_text": "Kabir paid ₹3,400 for the airport cab, split between all 5 (₹680 each)."
}
```

### Settle up

A settle up card shows who pays whom right now so that everyone is square. Go posts one when someone asks who owes what, or near the end of the trip.

go-server draws it from the trip's money (`money.transfers`): one row per payment, with both faces and the amount, such as "Priya pays Rahul ₹11,520". It always shows the transfers as they are now, so it changes as expenses are added or removed. When there are no transfers, it shows "Everyone is square".

**Buttons.** Each row has a UPI button, owned by go-server and shown to the person who pays, when the person being paid has a UPI id saved. It opens the payer's UPI app with the amount and the UPI id that go-server holds. go-brain never sees UPI ids.

<!-- schema: SettleUpCard -->
```json
{
  "card_id": "c_settle_1",
  "kind": "settle_up",
  "fallback_text": "To square up: Priya, Arjun and Meher each pay Rahul ₹11,520, and Kabir pays Rahul ₹8,120."
}
```

### Day

A day card shows one day of the itinerary. Go posts one when someone asks what is on for a day, or the evening before.

go-server draws it from the itinerary day with the card's `date`:
- The date ("Sat 7 Nov") and the day's title ("Meher's birthday").
- The items in time order, each with its time, title, a dot in its category's colour, its place, and its note.
- Each item's status: `booked` with a tick, `planned` as normal, and `idea` lighter, with an "idea" tag.

A tap on an item with a `booking_id` opens that booking's ticket. When the itinerary has no day for that date, show "Nothing planned for this day yet".

**Buttons.** The contract asks for none.

<!-- schema: DayCard -->
```json
{
  "card_id": "c_day_1107",
  "kind": "day",
  "date": "2026-11-07",
  "fallback_text": "Sat 7 Nov, Meher's birthday: brunch at Artjuna, sunset at Chapora Fort at 5:30 pm, dinner at Thalassa at 8:30 pm."
}
```

### Plan

A plan card shows the whole itinerary, day by day. Go posts one when someone asks for the plan, or after Go changes several days at once.

go-server draws it from the trip's itinerary: each day as a heading with its date and title, and under it each item's time, title and category colour, more compact than a day card. For a long trip, show the first days and a "See the whole plan" link to the Trip screens.

**Buttons.** The contract asks for none.

<!-- schema: PlanCard -->
```json
{
  "card_id": "c_plan_1",
  "kind": "plan",
  "fallback_text": "The Goa plan, 6 to 9 Nov. Fri: land 8:45 pm, cab, check in at Villa Sol. Sat: Meher's birthday, sunset at Chapora Fort. Open Go to see every day."
}
```

### Budget

A budget card shows what the group has spent against its plan, by category. Go posts one when someone asks how the money is going.

go-server draws it from the trip's money:
- A bar of what was spent (`spent_minor`) against the plan (`plan_minor`), split into the category colours from `by_category`.
- The totals: "₹57,600 of ₹75,000".
- One line per category, with its colour and amount.

When there is no plan, show what was spent by category, without the bar's end. The card never shows anyone's own budget answer.

**Buttons.** The contract asks for none.

<!-- schema: BudgetCard -->
```json
{
  "card_id": "c_budget_1",
  "kind": "budget",
  "fallback_text": "Spent ₹57,600 of the ₹75,000 plan: stay ₹54,200, getting around ₹3,400."
}
```

## Go cards

These five kinds carry everything they show, and their buttons are in `actions`.

### Options

An options card shows up to five options Go found, such as stays, flights or places, with their prices and when Go checked them. Go posts one when someone asks it to find something.

Draw it like this:
- The title, and "checked 3 min ago" from `checked_at`. Prices change, so always show when Go checked them. Go checks the price again before it books.
- One tile or row per option: the photo (`image_url`) or the logo (`logo_url`), the title and subtitle, the price with its currency and `price_note` ("₹5,920 per person"), the `highlights` as small chips (up to four), the rating when there is one, and "Free cancellation until ..." when `refundable_until` is set.
- For a journey (`journey`), the departure and arrival times, the codes ("DEL to GOI"), and the stops ("Non-stop" when `stops` is 0).
- For a place (`place`), its name and address.

`option_kind` says what the options are (`stay`, `flight`, `train`, `bus`, `place`, `food` or `activity`), in case the app draws some kinds differently.

**Buttons.** A button with `per_option` appears on every option, and its tap carries that option's `option_id`. Here "I'll take this" picks one flight, and "Put it to a vote" asks Go to open a vote on these options.

<!-- schema: OptionsCard -->
```json
{
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
}
```

### Working

A working card shows Go doing a longer job, such as comparing many stays or booking on a website, step by step. Go posts it when the job starts and updates it in place as the steps finish.

Draw it like this:
- The title, and the state: `running` as "Working on it" with a spinner, `needs_you` highlighted as "Needs you", `done` with a tick, and `failed` as "Didn't work".
- The steps as a checklist, each marked `todo`, `doing` (with a spinner), `done` (a tick) or `failed`.
- The latest picture of Go's screen (`screenshot_url`) as a small thumbnail, when there is one.
- "Updated 20 s ago", from `updated_at`.

When the job needs someone (for example, a one-time code), Go sets `needs_you` and names that person in `for_person_ids`, which pins the card in their strip.

**Buttons.** "Watch" opens a page where the person watches Go work, from the `open` answer. "Stop" stops the job.

<!-- schema: WorkingCard -->
```json
{
  "card_id": "c_villa_search",
  "kind": "working",
  "fallback_text": "Go is looking for villas with a pool in North Goa for 6 to 9 Nov.",
  "task_id": "task_villas_1",
  "title": "Finding villas with a pool in North Goa",
  "state": "running",
  "steps": [
    { "text": "Search ixigo for 3 nights, 6 to 9 Nov", "state": "done" },
    { "text": "Keep villas that sleep 5 and have a pool", "state": "done" },
    { "text": "Read the reviews of the best 8", "state": "doing" },
    { "text": "Pick three for a vote", "state": "todo" }
  ],
  "screenshot_url": "https://brain.go.example/img/task-villas-1-0007.jpg",
  "updated_at": "2026-10-05T07:12:40Z",
  "actions": [
    { "action_id": "watch", "label": "Watch", "style": "primary" },
    { "action_id": "stop", "label": "Stop", "style": "secondary" }
  ]
}
```

### Call

A call card shows Go on a phone call to a business, live, and then what came of it. Go posts it when the call starts and updates it in place as the call moves from dialing to talking to ended. The final version is the record of the call.

Draw it like this:
- The business and the goal: "Villa Sol: Ask if Arjun can check in at 11 pm".
- While `dialing`: "Calling Villa Sol...".
- While `talking`: the time since `started_at`, counting up on the phone, and the last line (`last_line`), marked as Go or as the business.
- When `ended`: the `outcome` in full, how long the call took (from `started_at` to `ended_at`), and the `transcript` under "Show transcript", one line per turn.
- When `failed`: "Couldn't get through", with the `outcome` if there is one.

**Buttons.** "Stop the call" while the call is live. Go removes it when the call ends.

This is the call to Villa Sol while it is live:

<!-- schema: CallCard -->
```json
{
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
```

And the same card once the call has ended:

<!-- schema: CallCard -->
```json
{
  "card_id": "c_villa_call",
  "kind": "call",
  "fallback_text": "Go called Villa Sol: 11 pm check-in is fine, Mohan will meet Arjun, and ₹2,000 off if we pay the deposit this week.",
  "call_id": "call_01",
  "business": "Villa Sol",
  "goal": "Ask if Arjun can check in at 11 pm",
  "state": "ended",
  "started_at": "2026-10-06T10:31:05Z",
  "ended_at": "2026-10-06T10:34:20Z",
  "last_line": { "who": "them", "text": "You're welcome. See you in November." },
  "outcome": "11 pm check-in is fine. The caretaker, Mohan, will meet Arjun. They offered ₹2,000 off if we pay the deposit this week.",
  "transcript": [
    { "who": "go", "text": "Hi, this is Go, an AI assistant calling for a group of five staying at Villa Sol from 6 to 9 November. One of us, Arjun, lands late. Can he check in at 11 pm?" },
    { "who": "them", "text": "Late check-in is fine, the caretaker can wait for him." },
    { "who": "go", "text": "Thank you. Who should he ask for when he arrives?" },
    { "who": "them", "text": "Mohan, our caretaker. He lives on the property. And if you pay the deposit this week, we can take ₹2,000 off." },
    { "who": "go", "text": "That's kind, I'll tell the group. Thanks for your help." },
    { "who": "them", "text": "You're welcome. See you in November." }
  ]
}
```

### Pay

A pay card shows a payment waiting for the payer to approve it. Go posts it after go-server signs a spend approval, and updates it in place when the payment is made, declined, expires or fails.

Draw it like this:
- The amount, large: "₹54,200".
- The merchant and the purpose: "ixigo: Villa Sol, Anjuna" and "Villa Sol, 3 nights, 6 to 9 Nov".
- "Free cancellation until Sun 1 Nov, 11:59 pm", from `refundable_until`.
- Who pays, with their face: "Rahul pays".
- While `waiting`, how long is left until `expires_at`. When `expires_at` passes, draw the card as expired even before Go's update arrives.
- The state once it changes: `paid` with a tick, `declined`, `expired`, or `failed`.

**Buttons.** "Approve" and "Decline", shown to the payer only (`only_for_person_ids`). Everyone else sees "Waiting for Rahul". Approve answers `open` with a link to the vault page, such as `https://brain.go.example/vault/approve?link=lk_4Rt8Zp2Lq`, which expires 5 minutes after it is made. The app opens it at once in the system browser sheet (`url_launcher` with `LaunchMode.inAppBrowserView`), never in `webview_flutter`, because Face ID passkeys do not work inside a plain WebView. On the vault page, the payer sees the amount, the merchant, the refundable-until date and their card, and confirms with Face ID.

This is the pay card for the villa, waiting for Rahul. The paid version is in [The trip API](03-trip-api.md#putcard-replace-a-card-in-place).

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

### Notice

A notice card tells the group something worth knowing, with where Go got it. Go posts one for news the group should see, and for something at risk: a deadline coming up, a price change, or a clash with a booking.

Draw it like this:
- The `tone` as a label at the top: `info` as "Good to know", and `heads_up` as "Heads up" in a warning colour.
- The title and the body, and the image (`image_url`) when there is one.
- The source's name, such as "timeanddate.com". When the source has a `url`, the name is a link that opens in the system browser sheet.
- "Checked 2 h ago", from `checked_at`.
- For a heads-up with `deadline_at`, the deadline ("by Sun 1 Nov, 11:59 pm") and how long is left.

**Buttons.** Usually none. When Go adds some, they work like any Go card's buttons.

A heads-up about a deadline:

<!-- schema: NoticeCard -->
```json
{
  "card_id": "c_villa_cancel_notice",
  "kind": "notice",
  "fallback_text": "Heads up: free cancellation on Villa Sol ends Sun 1 Nov, 11:59 pm.",
  "tone": "heads_up",
  "title": "Free cancellation on Villa Sol ends Sunday",
  "body": "Villa Sol is free to cancel until 11:59 pm on Sun 1 Nov. After that, the ₹54,200 is not refunded. If anyone's plans might change, now is the time to say.",
  "image_url": "https://brain.go.example/img/villa-sol.jpg",
  "source": { "name": "ixigo booking IXG-7Q2K9" },
  "checked_at": "2026-10-30T05:30:00Z",
  "deadline_at": "2026-11-01T18:29:59Z"
}
```

Something good to know, with its source:

<!-- schema: NoticeCard -->
```json
{
  "card_id": "c_sunset_notice",
  "kind": "notice",
  "fallback_text": "Good to know: sunset at Chapora Fort on Sat 7 Nov is about 6 pm. Be there by 5:30.",
  "tone": "info",
  "title": "Sunset at Chapora Fort on Saturday",
  "body": "The sun sets at about 6 pm on 7 Nov. The climb takes 10 minutes and the top gets busy, so be there by 5:30.",
  "image_url": "https://brain.go.example/img/chapora-fort.jpg",
  "source": { "name": "timeanddate.com", "url": "https://www.timeanddate.com/sun/india/panaji" },
  "checked_at": "2026-10-06T12:10:00Z"
}
```
