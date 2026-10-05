# Flows

This page walks through the big moments of a trip, step by step, as sequence diagrams with a short explanation under each. Use it to see how the requests, notifications and events on the other pages fit together, and to check that your part does its steps in the right order.

Every flow uses the Goa trip (`t_goa`). The participants are the people in the room, go-app, the server, go-brain and, where they take part, the vault or a business.

Every arrow between the server and go-brain is a frame on the one socket that the server keeps open to go-brain (see [The socket](02-the-socket.md)). A request, such as `send_event`, `read_trip` or `post_message`, is drawn as a solid arrow, and always gets one answer with the same id, drawn as a dashed arrow back and labelled "answer". `typing`, which shows "Go is typing...", is a notification, drawn as an open arrow, and gets no answer.

Every change Go makes (a message, a reaction, a vote, a record line, a booking) comes back from the server as an event with its own change number. That is how go-brain learns the change numbers of its own writes. The diagrams show this once, in the first flow, and leave it out after that to stay readable. They also leave out most of go-brain's answers to `send_event`, which always say `accepted`.

## 1. Go answers a question

This is the most common flow: someone asks Go for something in the room, and Go answers with text and a card.

```mermaid
sequenceDiagram
  autonumber
  actor Priya
  participant app as go-app
  participant server as server
  participant brain as go-brain
  Priya->>app: "@Go flights on Friday from Delhi, under 6k?"
  app->>server: send the message
  Note over server: stores m_0132 as change 57
  server->>app: the message, to everyone in the room
  server->>brain: send_event (message.created, seq 57, mentions_go true)
  brain-->>server: answer: accepted
  Note over brain: waits 2 s in case Priya adds more
  brain-)server: typing (on)
  server->>app: "Go is typing..."
  brain->>server: read_trip (t_goa)
  server-->>brain: answer: the trip at its current change number
  loop every 5 seconds while Go searches
    brain-)server: typing (on)
  end
  Note over brain: checks for anything new for it in the room
  brain->>server: post_message (text, options card c_flights_1, mentions Priya)
  server-->>brain: answer: message_id m_0133, seq 58
  server->>app: Go's message (typing ends), and a push to Priya
  server->>brain: send_event (message.created, seq 58, Go's own message)
  brain-->>server: answer: accepted
```

Priya's message mentions Go, so Go answers. go-brain answers the `send_event` at once and does the work afterwards. Go waits about 2 seconds in case Priya sends more. Then it sends the `typing` notification, so the room shows "Go is typing...", and repeats it every 5 seconds. It reads the trip with `read_trip` to learn the dates and who flies from Delhi, and searches. Just before it posts, it checks for anything new for it in the room, so a follow-up from Priya or someone else gets answered in the same reply. Then it posts one message with `post_message`: a line of text and an options card with three flights. The server answers with the new message's id and change number, pushes Priya because Go named her, and sends Go's message back to go-brain as an event with that change number.

## 2. A trip starts

This flow runs once per trip: the organizer creates the trip, and Go greets the room and opens the first vote.

```mermaid
sequenceDiagram
  autonumber
  actor Rahul
  actor Priya
  participant app as go-app
  participant server as server
  participant brain as go-brain
  Rahul->>app: creates the trip "Goa 🌴"
  app->>server: create the trip
  Note over server: stores t_goa with Rahul as organizer<br/>and the invite link go.example/j/8fK2xQ
  server->>brain: send_event (trip.created, seq 1, the whole trip)
  brain-->>server: answer: accepted
  Note over brain: sets the trip up: Go's memory, a page per person,<br/>its queue and conversation, and starts the trip's computer
  brain->>server: open_vote (When do we go? three date options)
  server-->>brain: answer: decision_id d_when, seq 2
  server->>brain: send_event (decision.opened, d_when, seq 2)
  brain->>server: post_message (a hello and the vote card)
  server->>app: Go's hello with the dates vote
  Rahul->>app: shares the invite link with his friends
  Priya->>app: joins with the link and answers the join questions
  app->>server: join t_goa
  server->>brain: send_event (person.joined, Priya, from Delhi, vegetarian, window seat)
  Note over brain: notes what Priya told Go and stays quiet
```

`trip.created` carries the whole trip, so Go can start without reading anything else. go-brain answers at once, then sets the trip up: Go's memory, a page for each person, its queue and its conversation take a few seconds, and the trip's own computer starts in the background so it is ready for the first task (see [How go-brain sets Go up for a new trip](03-events.md#how-go-brain-sets-go-up-for-a-new-trip)). Go says hello and opens the first vote. Here it asks about the dates, which are not set yet. It could instead open a yes/no "Who's in?" vote. Opening a vote takes two requests: `open_vote` creates the vote, then `post_message` with a vote card shows it in the room. As friends join through the invite link, the server sends `person.joined` for each of them. Go keeps what they said about themselves and does not post a welcome for every person. When the vote `d_when` closes, the server writes the decided line "6 to 9 Nov" (`r_dates`) itself.

## 3. The group agrees in the chat without a vote

This flow shows how something the group settles in plain conversation ends up in the trip record, how Go shows that it noted it without speaking, and how a person can take it back.

```mermaid
sequenceDiagram
  autonumber
  actor Priya
  actor Arjun
  actor Rahul
  actor Kabir
  participant app as go-app
  participant server as server
  participant brain as go-brain
  Priya->>app: "Let's do North Goa, not South. Better beaches for us."
  app->>server: send
  server->>brain: send_event (message.created, m_0122)
  Arjun->>app: "Yes, North. It's closer to the airport for my late flight too."
  app->>server: send
  server->>brain: send_event (message.created, m_0124)
  Rahul->>app: 👍 on Priya's message
  app->>server: react
  server->>brain: send_event (reaction.added, m_0122, from Rahul)
  Note over brain: Priya, Arjun and Rahul said yes and nobody objected
  brain->>server: add_record_line (agreed, "North Goa, not South", proof m_0122 and m_0124)
  server-->>brain: answer: line_id r_north
  server->>brain: send_event (record.changed, added, by Go)
  server->>app: the trip record shows the new line
  brain->>server: add_reaction (✅ on m_0122)
  server-->>brain: answer: its change number
  server->>app: Priya's message shows Go's ✅
  server->>brain: send_event (reaction.added, m_0122, ✅ from Go, no person_id)
  Note over brain: does not announce the line in the room
  opt if Kabir disagrees later
    Kabir->>app: undoes the line in the trip record
    app->>server: undo r_north
    server->>brain: send_event (record.changed, undone, by Kabir)
    Note over brain: never writes the line back on its own
  end
```

Nobody asked Go anything, so Go stays quiet and takes notes. Priya proposed North Goa, Arjun said yes, and Rahul added a 👍 to Priya's message, which counts as a yes (`reaction.added`). An agreed line needs two people saying yes, or the organizer alone, and nobody objecting. That holds here, so Go writes an agreed line with `add_record_line`, with Priya's and Arjun's messages as proof. If someone had objected, Go would have written an open line instead. Go does not announce the line. Instead, it adds a quiet ✅ to Priya's message with `add_reaction`, so the room can see that Go noted it. That reaction is a change like any other, so the server sends it back as `reaction.added`, with no `person_id` because Go made it. If Kabir disagreed, he could undo the line in the app (the last part of the diagram). In the Goa trip nobody does, so the line stays. Only people can undo a line. Go never undoes one and never writes it back, and if the group settles the question again later, Go writes a new line.

## 4. From a vote to a booking

This flow takes the villa vote all the way to a paid booking. Every check in it is explained in [Money and the vault](08-money-and-the-vault.md), which has a more detailed diagram of the same payment.

```mermaid
sequenceDiagram
  autonumber
  actor Rahul as Rahul (payer)
  participant app as go-app
  participant server as server
  participant brain as go-brain
  participant vault as go-brain vault page
  participant ixigo
  Note over server: the last person votes and Villa Sol wins 4 to 1
  server->>brain: send_event (decision.closed, d_villa, everyone_voted)
  server->>brain: send_event (record.changed, a decided line written by the server)
  brain->>server: set_mandate (d_villa, cap ₹55,000, refundable only, payer Rahul)
  server->>brain: send_event (mandate.set)
  brain->>server: post_message (the result, and mandate card c_villa_mandate)
  server->>app: "Yes, book it" and "Not now" for Rahul only
  Rahul->>app: taps "Yes, book it"
  app->>server: Yes, book it
  server->>brain: send_event (mandate.confirmed)
  brain->>ixigo: checks the price again (₹54,200)
  brain->>server: request_spend_approval (d_villa, ₹54,200)
  server-->>brain: answer: approved (ap_01JA7Q3V8Z, valid 10 minutes)
  brain->>server: post_message (pay card c_villa_pay for Rahul)
  Rahul->>app: taps Approve
  app->>server: the tap
  server->>brain: card_tap (tap_0457, c_villa_pay, approve, p_rahul)
  brain-->>server: answer: open, with a vault link
  server-->>app: open the link
  app->>vault: opens it in the system browser sheet
  Rahul->>vault: Face ID, then the CVV and the bank's one-time code
  vault->>ixigo: pays once
  brain->>server: add_booking (b_villa, approval_id ap_01JA7Q3V8Z)
  server-->>brain: answer: booking_id b_villa, seq 76
  server->>brain: send_event (booking.changed, added), and record.changed for the booked line r_villa
  brain->>server: add_expense (Rahul paid, split between all five)
  brain->>server: post_message (ticket card c_villa_ticket)
  brain->>server: replace_card (c_villa_pay, paid)
```

The vote closes when the last person votes, and the server writes the decided line itself. A closed vote is a moment Go speaks, so it sets the mandate with `set_mandate` and posts the result together with the mandate card. The mandate says what the group allowed: Villa Sol, at most ₹55,000, refundable only, paid by Rahul. Only Rahul sees "Yes, book it". When he taps it, Go checks the price again and asks the server for a spend approval with `request_spend_approval`. The server runs the spend check and answers with a signed, one-use approval. Go then posts a pay card that only Rahul can approve. His tap reaches go-brain as `card_tap`, with the server's `tap_id` so that a tap sent twice is acted on once, and go-brain answers `open` with a link to the vault page, which the app opens in the system browser sheet. There he confirms with Face ID and types his CVV. The vault checks the approval and pays ixigo once. Go records the booking with `add_booking` and the approval's id (the server marks the approval used and writes the booked line), records the expense with `add_expense`, posts the ticket, and turns the pay card to paid with `replace_card`.

## 5. A phone call

This flow shows Go calling a business for the group: it says who it will call, gives the room a chance to stop it, and keeps a live card of the call.

```mermaid
sequenceDiagram
  autonumber
  actor Arjun
  participant app as go-app
  participant server as server
  participant brain as go-brain
  participant villa as Villa Sol front desk
  Arjun->>app: "@Go I land late on the 6th. Can you check with Villa Sol that an 11 pm check-in is ok?"
  app->>server: send
  server->>brain: send_event (message.created, mentions_go true)
  brain->>server: post_message (who Go will call and why, and that anyone can say stop)
  Note over brain: waits 30 seconds. Nobody says stop.
  brain->>server: post_message (call card c_villa_call, dialing)
  brain->>villa: calls the front desk
  brain->>server: replace_card (c_villa_call, talking, the latest line)
  server->>app: the call card updates live
  villa-->>brain: 11 pm is fine, Mohan will meet him, ₹2,000 off for paying the deposit this week
  brain->>server: replace_card (c_villa_call, ended, outcome, transcript)
  brain->>server: post_message (replies to Arjun with the outcome, names Rahul)
  brain->>server: add_record_line (open, the deposit offer, asks Rahul)
  server->>brain: send_event (record.changed, added, by Go)
```

Before it dials, Go tells the room who it will call and what it will ask: "I'll call Villa Sol's front desk to ask if Arjun can check in at 11 pm. Say stop in the next 30 seconds if you'd rather I didn't." Anyone can stop it by replying in that time, and a reply to Go reaches go-brain as a message that mentions Go. Once the call starts, Go posts a call card (`call_01`) and updates it in place with `replace_card` as the call moves from dialing to talking to ended. Those updates send no events. While it runs, the card's Stop button ends the call. The final card holds the outcome and the transcript, and it is the record of the call. Go replies to Arjun with the outcome: "11 pm check-in is fine. The caretaker, Mohan, will meet Arjun. They offered ₹2,000 off if we pay the deposit this week." The discount needs a decision, so Go also writes an open line in the trip record with `add_record_line` that asks Rahul, the payer.

## 6. Someone opens the room after a while

This flow shows catch-up: a short summary, for one person only, of what happened while they were away.

```mermaid
sequenceDiagram
  autonumber
  actor Meher
  participant app as go-app
  participant server as server
  participant brain as go-brain
  Meher->>app: opens the Goa room after 6 hours away (23 unread)
  app->>server: open the room
  server-->>app: the room, straight away
  server->>brain: catch_up (t_goa, p_meher, since she last looked)
  brain-->>server: answer: one summary line and up to 5 items, within 3 seconds
  server-->>app: the catch-up, for Meher only
  Note over app: shows it above the room.<br/>Nobody else sees it, and it is never posted.
```

Meher has been away for more than 3 hours, so the server sends go-brain a `catch_up` request while it shows her the room. go-brain answers within 3 seconds with one sentence in Go's voice ("While you were away, the group picked Villa Sol and Go booked it.") and a few items: the vote result, the booking, and the open question about scuba on Saturday, which asks her. The app shows it above the room for Meher alone. Tapping an item scrolls to its message. If go-brain is slow or fails, Meher simply sees the room without it.

## 7. Forget me

This flow shows a person seeing what Go knows about them and asking Go to forget it.

```mermaid
sequenceDiagram
  autonumber
  actor Kabir
  participant app as go-app
  participant server as server
  participant brain as go-brain
  Kabir->>app: opens "What Go knows about you"
  app->>server: what Go knows about me
  server->>brain: get_person (p_kabir)
  brain-->>server: answer: his facts, each with its topic and where it came from
  server-->>app: the list
  Kabir->>app: taps "Forget me in this trip"
  app->>server: forget me in t_goa
  server->>brain: forget_person (p_kabir, trip_id t_goa)
  Note over brain: deletes his facts from this trip,<br/>then checks that none are left
  brain-->>server: answer: deleted_facts 3, remaining_facts 0
  server-->>app: "Go forgot 3 things about you in this trip"
```

The app never talks to go-brain itself. The server takes Kabir's `person_id` from his signed-in session and sends both requests for him: `get_person`, then `forget_person`. go-brain answers with every fact it holds about him, each with where it came from, so he can see why Go knows it. "Forget me in this trip" sends the `trip_id`, and "Forget me everywhere" leaves it out. go-brain deletes the facts, checks that none are left, and only then answers, so `remaining_facts` is always 0. The room's messages stay, because the rest of the group can still see them.

## 8. go-brain misses an event

This flow shows how go-brain notices a missed event from the change numbers and catches up, so nothing in the trip is lost.

```mermaid
sequenceDiagram
  autonumber
  participant server as server
  participant brain as go-brain
  Note over brain: has handled every change in t_goa up to seq 101
  server-xbrain: event seq 102 never arrives (the server gave up on it)
  server->>brain: send_event (seq 103)
  brain-->>server: answer: accepted
  Note over brain: holds 101 and sees 103, so 102 is missing
  brain->>server: read_trip (t_goa)
  server-->>brain: answer: the trip at its current change number
  brain->>server: read_messages (t_goa, after_seq 101)
  server-->>brain: answer: the messages posted or changed after change 101
  Note over brain: handles what it missed, then carries on in seq order
  server->>brain: send_event (seq 104)
  brain-->>server: answer: accepted
```

The server sends each trip's events in order, one at a time, so a gap is rare. It can happen when the server gives up on an event, for example after an `invalid` error that it does not retry, or after 24 hours without an answer. It can also happen when go-brain loses events it had accepted but not yet handled. go-brain still accepts event 103 straight away. Because it holds 101 and sees 103, it sends the server `read_trip` for the whole trip and `read_messages` for the messages posted or changed after change 101 (`updated_seq` above 101), handles what it missed, and then carries on. Whatever the gap was (a message, a vote, a booking), the trip and the messages cover it.

Good to know:
- go-brain also reads every active trip once a minute with `read_trip`, so it catches up even when no later event arrives to show the gap.
- A dropped socket is not a gap. The server's socket client sends every unanswered request again after it reconnects, with the same id and the same `event_id`, and go-brain handles each event once.
- An event that arrives twice is not a gap. go-brain answers `{"accepted": true, "duplicate": true}` and does nothing.
- go-brain answers `accepted` to an event type it does not know, and skips it.
