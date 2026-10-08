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
| A7 | A booking's extra lines, return leg, passengers with seats and PNRs, and documents | Go | `add_booking` and `Booking`: `details`, `return_journey`, `passengers`, `documents` |
| A8 | An itinerary item for some people, or private; a picture for a day | Both | `ItineraryItem.person_ids`, `audience`; `Day.image_url` |
| A9 | A vote taken back | The Server | `decision.voted` `retracted` |
| A10 | The `claim` card action: the first claim wins | Go | a card's `actions` |
| A11 | A place's time zone | Both | `Place.timezone` |
| B1 | A payback someone recorded, once the one paid confirmed it | The Server | the `settlement.recorded` event |
| B2 | A checklist card; a vault link to add documents | Go; the Server asks | the `checklist` card; `vault_link` `start: "add_documents"` and `context` |
| B3a | A call's recording and length | Go | `CallCard.recording_url`, `duration_s` |
| B4 | Whether the people an expense is split between agreed to it | The Server | `Expense.status`, `confirmations`; `expense.changed` `approved`, `disputed` and `by_person_id` |

Not in 1.1: listening to a call live (B3b), `request_task` (B3c), and the check-in methods (Group C). They come after the hackathon.

## Options and votes (A1, A2)

An option's `details` is what the App shows when someone opens the option. Every field in it is optional, and the App shows what is there. `costs` lists what the price is made of, each line in the trip's currency, and `total_minor` adds them up. `rating` is the rating as the source gives it: out of 5, or out of 10 where the source rates out of 10 (ixigo's hotel scores). A vote's option (`DecisionOption`) can carry the same `details`, so the vote card can open each choice.

An option with both `price_oneway_minor` and `price_round_minor` lets the App offer one way or the round trip on its button. The tap then carries the choice:

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

A card action's `open` answer may now name one of the App's own screens with a `go://` link, which the App opens in place instead of in the browser sheet. The App team's route table lists the screens and their links. Links stay `http`, `https` or `go`, never anything else.

`claim` is a card action for something one person takes on ("I'll book the cab"). The Server sends the tap to Go like any other. The first claim wins: Go answers `done` to the first tap and `refused` to the ones after it, with a toast naming who has it.

## Votes (A5, A9)

`decision.voted` can now say a person is flexible (`"flexible": true`) or took their vote back (`"retracted": true`). Neither has an `option_index`. A flexible person counts in `voted` and never in `tally`, and the decision's `flexible_count` says how many are flexible. A vote taken back counts nowhere: `voted` and `tally` come without it.

## Locations and voice notes (A6)

A message can carry a shared location: `{ "kind": "location", "lat": 15.6, "lng": 73.7, "name": "Anjuna beach" }`, with `name` and `address` optional. A file's `duration_s` says how long a voice note or a video plays.

## Bookings (A7)

`add_booking` (and so `Booking`) can carry extra lines (`details`), the way back (`return_journey`), each traveller with a seat and PNR (`passengers`), and the booking's documents. A document's `url` is Go's signed link: the Server fetches it once, keeps its own copy, and serves that copy from then on. The link stops working after a while, so fetch it when the booking arrives. `visibility` says who may see the document: `group`, `shared` (the booking's passengers) or `private` (the one person it is for).

## Itinerary (A8) and places (A11)

An itinerary item can name the people it is for (`person_ids`) and who sees it (`audience`: `group`, `shared` or `private`, the group when absent). A day can have a picture (`image_url`). A place can carry its IANA time zone (`timezone`, such as `Asia/Kolkata`).

## Paybacks (B1)

The Server sends `settlement.recorded` when someone paid someone back and the one paid confirmed it. Only confirmed paybacks are sent. `method` is `upi`, `cash`, `bank_transfer` or `other`. The Server does the money maths, so Go reads `money` from the trip again.

Priya paid Rahul back ₹1,200 in cash for the cab, and Rahul confirmed it:

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
      "settlement_id": "s_0007",
      "from_person_id": "p_priya",
      "to_person_id": "p_rahul",
      "amount_minor": 120000,
      "currency": "INR",
      "method": "cash",
      "note": "Airport cab",
      "confirmed_at": "2026-10-10T09:15:00Z"
    },
    "by": { "kind": "person", "person_id": "p_rahul" }
  }
}
```

## Checklists and documents (B2)

A `checklist` card is a list Go keeps for the group or one person: documents to upload, things to pack, check-ins to do. Each row is `todo`, `started`, `done` or `info` (a line to read, with nothing to do), and may name whose row it is. Go updates the card in place with `replace_card` as rows change.

<!-- schema: ChecklistCard -->
```json
{
  "card_id": "c_check_docs",
  "kind": "checklist",
  "fallback_text": "Documents for the trip: 1 of 3 done",
  "title": "Documents for the trip",
  "rows": [
    { "row_id": "r_rahul_id", "label": "Rahul: ID for the train", "status": "done", "person_id": "p_rahul" },
    { "row_id": "r_priya_id", "label": "Priya: ID for the train", "status": "todo", "person_id": "p_priya", "due_at": "2026-11-05T12:00:00Z" },
    { "row_id": "r_voucher", "label": "The villa sends its voucher on 5 Nov", "status": "info" }
  ],
  "actions": [{ "action_id": "upload", "label": "Add documents", "style": "primary" }]
}
```

`vault_link` takes `start: "add_documents"` and an optional `context` (the trip, booking, card or row the documents go with). In 1.1 Go answers it `409 conflict`, "Adding documents in the vault is not available yet.", until the vault has that page.

## Calls (B3a) and expenses (B4)

A finished call's card can carry its `recording_url` and `duration_s`.

An expense can say whether the people it is split between agreed to it: `status` is `pending`, `approved` or `disputed`, and `confirmations` holds each person's answer. When someone answers, the Server sends `expense.changed` with `change` `approved` or `disputed`, and `by_person_id` says who answered.

Priya disputed the cab, because she took the bus:

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
      "paid_by_person_id": "p_kabir",
      "amount_minor": 340000,
      "currency": "INR",
      "note": "Airport cab",
      "category": "getting_around",
      "split_person_ids": ["p_rahul", "p_priya", "p_arjun", "p_meher", "p_kabir"],
      "added_by_person_id": "p_kabir",
      "created_at": "2026-10-09T13:20:00Z",
      "status": "disputed",
      "confirmations": [{ "person_id": "p_priya", "answer": "disputed", "at": "2026-10-10T08:40:00Z", "note": "I took the bus" }]
    },
    "change": "disputed",
    "by": { "kind": "person", "person_id": "p_priya" },
    "by_person_id": "p_priya"
  }
}
```

## What Go tolerates

- A message from the Server itself (author `system`) in an event, `read_messages` or a catch-up is kept, and Go never answers it as if a person spoke.
- `replace_card` is not a change, but a Server that moves a message's `updated_seq` when Go replaces its card may hand it back from `read_messages`. That wakes nobody, and Go never answers a message twice.
- An `expense.changed` with a change value Go does not know is answered `422 invalid`, as above, and the socket goes on.
