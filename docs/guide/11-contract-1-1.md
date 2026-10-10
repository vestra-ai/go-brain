# Contract 1.1

Contract 1.1 adds what the Server team proposed for the App's richer screens: option details, round trips, quick replies, flexible votes, locations, booking documents, checklists, call recordings, expense answers and paybacks. Every addition is optional: a new field, a new value, a new event type or a new card kind. Nothing is renamed or removed, so a Server or App built for 1.0 keeps working, and `GET /v1/health` now answers `"contract": "1.1.0"`.

The zod schemas in `packages/contract` (and the generated `openapi/go.json`, `asyncapi/socket.json`, `socket/methods.json` and the Python models) are the exact shapes. This page says what each addition means and who sends it.

Good to know:
- A side that does not use an addition yet ignores it, as it ignores any field it does not know.
- New values on an existing field (an `option_kind` of `cab`, an `expense.changed` change of `approved`) need a reader that speaks 1.1. Go 1.1 takes every new value the Server sends, and Go's lanes start sending theirs once the Server team has 1.1 deployed.
- Go answers `422 invalid` for a value newer than 1.1 on an event it knows, as for any event that breaks the contract. The Server marks that event failed and moves on, and Go reads the trip at the gap.

## What changed, by who sends it

| | Addition | Sent by | Where |
|---|---|---|---|
| A1 | `details` on an option and on a vote's option: photos, why Go picked it, the costs line by line, amenities, activities, facts, cancellation, rating, reviews, Go's note | Go | `Option.details`, `DecisionOption.details` |
| A2 | A return leg and both prices on an option; `cab` options; the tapper's one way or round trip choice on a tap | Go; the App on a tap | `Option.return_journey`, `price_oneway_minor`, `price_round_minor`; `option_kind` `cab`; `card_tap.payload.trip` |
| A3 | Up to six quick replies under Go's message, kept on the message | Go | `post_message.quick_replies`, `Message.quick_replies` |
| A4 | A card action's `open` can be one of the App's own screens, by a `go://` link | Go | `ActionOpen.url` |
| A5 | "I'm flexible" as a vote: counted in `voted`, never in the tally | The Server | `decision.voted` `flexible`, `Decision.flexible_count` |
| A6 | A shared location, and how long a voice note or video plays | The Server | `Attachment` kind `location`, `FileAttachment.duration_s` |
| A7 | A booking's extra lines, return leg, passengers with seats and PNRs, and documents (`covered` or `group`) | Go | `add_booking` and `Booking`: `details`, `return_journey`, `passengers`, `documents` |
| A8 | An itinerary item for some people, or private; a picture for a day | Both | `ItineraryItem.person_ids`, `audience`; `Day.image_url` |
| A9 | A vote taken back | The Server | `decision.voted` `retracted` |
| A10 | The `claim` card action: the first claim wins | Go | a card's `actions` |
| A11 | A place's time zone | Both | `Place.timezone` |
| B1 | A payback someone recorded (it counts at once since 10 Oct) | The Server | the `settlement.recorded` event |
| B2 | A checklist card; a vault link to add documents | Go; the Server asks | the `checklist` card; `vault_link` `start: "add_documents"` and `context` |
| B3a | A call's recording and length | Go | `CallCard.recording_url`, `duration_s` |
| B4 | The vault payment an expense was paid with; a fixed split (`updated`). Whether people agreed to an expense was withdrawn on 10 Oct | The Server; Go | `add_expense.approval_id`; `expense.changed` `updated`; withdrawn: `Expense.status`, `confirmations`, `expense.changed` `approved`, `disputed`, `by_person_id` |
| 10 Oct A3, B1 | The group's one budget per person, in place of private budget answers | The Server; Go | `BudgetSummary.per_person_minor`; `update_trip.budget_per_person_minor` |

Not in 1.1: listening to a call live (B3b), `request_task` (B3c), and the check-in methods (Group C). They come after the hackathon.

## Options and votes (A1, A2)

An option's `details` is what the App shows when someone opens the option. Every field in it is optional, and the App shows what is there. `costs` lists what the price is made of, each line in the trip's currency, and `total_minor` adds them up. `rating` is the rating as the source gives it: out of 5, or out of 10 where the source rates out of 10 (ixigo's hotel scores). A vote's option (`DecisionOption`) can carry the same `details`, so the vote card can open each choice.

An option with both `price_oneway_minor` and `price_round_minor` lets the App offer one way or the round trip on its button. `price_minor` stays the price the card shows. The `pick` tap then carries the choice:

<!-- schema: CardTap -->
```json
{
  "tap_id": "tp_0418",
  "trip_id": "t_goa",
  "card_id": "c_opt_flights_1",
  "action_id": "pick",
  "person_id": "p_priya",
  "option_id": "o_6e2134",
  "payload": { "trip": "round" }
}
```

## Quick replies (A3)

Go can offer up to six replies under its message. Each has a `label` of up to 40 characters, and an optional `text`. The Server keeps them on the Message, and `read_messages` returns them. When someone taps one, the App posts `text` (or the label, when there is no text) as that person's own message, so Go hears it as an ordinary `message.created`. There is no tap call for a quick reply.

<!-- schema: PostMessage -->
```json
{
  "request_id": "go_req_0921",
  "trip_id": "t_goa",
  "text": "Villa Maya is free for 6 to 9 Nov at ₹8,400 a night. Shall I hold it?",
  "quick_replies": [
    { "label": "Yes, hold it" },
    { "label": "Show cheaper ones", "text": "@Go show us something cheaper" }
  ]
}
```

## App screens and claims (A4, A10)

A card action's `open` answer may now name one of the App's own screens with a `go://` link, which the App opens in place. An `https://` link still means "open in the browser sheet". Links stay `http`, `https` or `go`, never anything else. These are the App's screens (the Server team's route table):

| Link | The screen |
|---|---|
| `go://trips/<trip_id>/sheet/budget` | The budget sheet |
| `go://trips/<trip_id>/sheet/route` | The route sheet, on an options card |
| `go://trips/<trip_id>/sheet/cab` | The cab sheet, on an options card |
| `go://trips/<trip_id>/bookings/<booking_id>` | My booking, for the person who tapped only |
| `go://trips/<trip_id>/itinerary` | The Trip tab's itinerary |
| `go://trips/<trip_id>/bookings` | The Trip tab's bookings |
| `go://trips/<trip_id>/expenses` | The Trip tab's expenses |
| `go://trips/<trip_id>/checkin/<booking_id>` | Check-in (Group C, not in 1.1) |

`claim` is a card action for something one person takes on ("I'll book the cab"). The Server sends the tap to Go like any other. The first claim wins: Go answers `done` to the first tap and `refused` to the ones after it, with a toast naming who has it.

## Votes (A5, A9)

`decision.voted` can now say a person is flexible (`"flexible": true`) or took their vote back (`"retracted": true`). Neither has an `option_index`. A flexible person counts in `voted` and never in `tally`, and the decision's `flexible_count` says how many are flexible. After a vote is taken back, `voted` and `tally` are the new totals, without it.

## Locations and voice notes (A6)

A message can carry a shared location: `{ "kind": "location", "lat": 15.6, "lng": 73.7, "name": "Anjuna beach" }`, with `name` and `address` optional. A file's `duration_s` says how long a voice note or a video plays.

## Bookings (A7)

`add_booking` (and so `Booking`) can carry extra lines (`details`), the way back (`return_journey`), each traveller with a seat and PNR (`passengers`), and the booking's documents. A document's `url` is Go's signed link, valid at least 10 minutes: the Server fetches it once, keeps its own copy, and serves that copy from then on, so fetch it when the booking arrives. `visibility` says who may see the document: `covered` (only the people the booking covers) or `group` (everyone in the trip).

## Itinerary (A8) and places (A11)

An itinerary item can name the people it is for (`person_ids`) and who sees it (`audience`: `group`, `shared` or `private`, the group when absent). A day can have a picture (`image_url`). A place can carry its IANA time zone (`timezone`, such as `Asia/Kolkata`).

## Paybacks (B1)

The Server sends `settlement.recorded` when someone records that they paid someone back. Since 10 Oct a payback counts as soon as it is recorded: nobody confirms it, and it cannot be undone. So `status` is always `confirmed`, `confirmed_at` is when it was recorded, and Go never sees a pending or disputed one. `method` is `upi`, `cash`, `bank_transfer` or `other`. `note` and `recorded_at` are optional. `read_trip`'s `money.transfers` already counts it, so Go reads the money again.

Aarav paid Rahul back ₹5,800 by UPI for the villa and groceries:

<!-- schema: SettlementRecorded -->
```json
{
  "event_id": "ev_0131",
  "trip_id": "t_goa",
  "seq": 131,
  "occurred_at": "2026-10-10T09:15:00Z",
  "type": "settlement.recorded",
  "data": {
    "settlement": {
      "settlement_id": "st_0007",
      "from_person_id": "p_aarav",
      "to_person_id": "p_rahul",
      "amount_minor": 580000,
      "currency": "INR",
      "method": "upi",
      "note": "villa + groceries",
      "status": "confirmed",
      "recorded_at": "2026-10-10T09:15:00Z",
      "confirmed_at": "2026-10-10T09:15:00Z"
    },
    "by": { "kind": "person", "person_id": "p_aarav" }
  }
}
```

## Checklists and documents (B2)

A `checklist` card shows who in the group has something ready, one row a person (a visa on arrival, for example). Each row is `todo`, `started`, `done` or `info` (a line to read, with nothing to do), with a `label` and an optional `sub` line. Rows are keyed by `person_id`, with no row ids and no row buttons: Go updates the card in place with `replace_card`. The card can have a `subtitle`, the day it is due (`due_at`, a date), and one `suggestion` with an optional button (`cta`), whose tap reaches Go like any card action.

<!-- schema: ChecklistCard -->
```json
{
  "kind": "checklist",
  "card_id": "c_visa",
  "title": "Indonesia e-VOA",
  "subtitle": "Each of you needs one before you fly",
  "due_at": "2026-12-10",
  "rows": [
    { "person_id": "p_aarav", "status": "todo", "label": "Not yet", "sub": "Passport, photo" },
    { "person_id": "p_rahul", "status": "done", "label": "Done" }
  ],
  "suggestion": { "text": "You and Arjun land together. Share a cab?", "cta": { "action_id": "cab", "label": "Book" } },
  "actions": [],
  "fallback_text": "Indonesia e-VOA: 1 of 2 done"
}
```

`vault_link` takes `start: "add_documents"` and an optional `context` (`{ "trip_id": "t_bali", "purpose": "visa" }`). In 1.1 Go answers it `409 conflict`, "Adding documents in the vault is not available yet.", until the vault has that page.

## Calls (B3a) and expenses (B4)

A finished call's card can carry its `recording_url` (Go's own signed link, which stops working after a while) and `duration_s`.

Every expense counts from the moment it is added until it is removed. Nobody approves or disputes one: that was withdrawn on 10 Oct, so the Server no longer sends `Expense.status` or `confirmations`, nor `expense.changed` with `approved` or `disputed`. The schemas keep them, so what an older Server sends still reads, and Go says nothing of them.

`add_expense` gains `approval_id`, the spend approval a vault payment used (the same id as on its booking): the vault payment the expense belongs to.

A person can fix an expense's split. The Server then sends `expense.changed` with `change` `updated`, carrying the whole expense, and Go reads the trip again. Priya took Aarav off the airport cab:

<!-- schema: ExpenseChanged -->
```json
{
  "event_id": "ev_0129",
  "trip_id": "t_goa",
  "seq": 129,
  "occurred_at": "2026-10-10T08:40:00Z",
  "type": "expense.changed",
  "data": {
    "expense": {
      "expense_id": "e_cab",
      "paid_by_person_id": "p_priya",
      "amount_minor": 170000,
      "currency": "INR",
      "note": "Airport cab",
      "category": "getting_around",
      "split_person_ids": ["p_rahul", "p_priya", "p_kabir"],
      "added_by_person_id": "p_priya",
      "created_at": "2026-10-09T13:20:00Z"
    },
    "change": "updated",
    "by": { "kind": "person", "person_id": "p_priya" }
  }
}
```

## The group's budget (10 Oct: A3, B1)

People no longer answer a private budget question. A trip has one optional budget per person, the same for everyone, set in the App or by Go. `read_trip`'s `budget` then carries it as `per_person_minor`, and the rest of it reads as everyone answering that one amount, so a reader that does not know the field still sees the right band. With none set, `budget` is `{ "answered": 0, "of": 4 }`. A change comes as `trip.updated` with `changed: ["budget"]`, by the person who set it, or by Go. This replaces what chapters 3 and 4 say about budget answers being private and changes coming by `system`.

The group set ₹20,000 each:

<!-- schema: BudgetSummary -->
```json
{
  "lowest": { "min_minor": 2000000, "max_minor": 2000000, "currency": "INR" },
  "answered": 4,
  "of": 4,
  "per_person_minor": 2000000
}
```

When the group settles one in the chat (the organizer says it, or two people agree), Go sets it with `update_trip`. It is a whole number of at least 1 in the trip's currency. Missing or `null` leaves it as it is, so Go cannot clear it: a person clears it in the App. Go sends only a budget for the whole trip; one the group set only for the stay or for getting there stays Go's own.

<!-- schema: UpdateTrip -->
```json
{ "request_id": "go_budget_01J9XG", "trip_id": "t_goa", "budget_per_person_minor": 2000000 }
```

## What Go tolerates

- A message from the Server itself (author `system`) in an event, `read_messages` or a catch-up is kept, and Go never answers it as if a person spoke. That covers the money lines the Server posts for every expense and payback ("Priya added Airport cab · ₹1,700 · split 4 ways"): Go reads them as the App's record, never wakes for one, never replies or reacts to one, and never comments on one.
- `replace_card` is not a change, but a Server that moves a message's `updated_seq` when Go replaces its card may hand it back from `read_messages`. That wakes nobody, and Go never answers a message twice.
- An `expense.changed` with a change value Go does not know is answered `422 invalid`, as above, and the socket goes on.
