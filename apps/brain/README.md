# apps/brain: Go's service

This is Go itself. The Server opens one signed WebSocket to it at `GET /v1/socket` and sends every change in a trip as an event. Go reads each person's message, decides whether it needs Go, and when it does, runs one model turn that may use quick tools and posts one reply through the same socket. Next to that it keeps a memory of each person with proof, speaks up on its own when it truly helps, and can phone a business for the group.

It is a Fastify service on Node 22 with Postgres 16. It applies its migrations at boot (`src/db/migrations`), and every variable it reads is listed in [`.env.example`](.env.example).

## How a service is put together

`src/app.ts` builds the core (`buildBrain`): the socket, the trip log, the desk and the composer. Every other part is a lane that registers itself on that core through one function. [`src/main.ts`](src/main.ts) lists the lanes in boot order (`LANES`): the room, the reflex, memory, proactive and calls. A lane adds quick tools, blocks of "right now" for the prompt, handlers for the Server's requests, and listeners on events and messages, and it stops its own timers when Go stops.

## The folders under `src/`

| Folder | What it does |
|---|---|
| `door/` | The socket: checks the Server's signature on the upgrade and accepts each signature once, pings every 20 s, answers each JSON-RPC request once, and sends Go's own requests to the Server (`server-link.ts`), resent with the same id after a reconnect. `methods.ts` types all 26 methods of the contract; `taps.ts` routes card taps by card kind, once per tap. |
| `trips/` | Every event once, in change-number order per trip (`log.ts`); each active trip's working set kept current from events (`pack.ts`); `send_event` handling (`intake.ts`): typing at once when someone names Go, then the reflex, the lanes' message hooks and the desk. Card numbers, CVVs and one-time codes are hidden at the door (`screen.ts`), before anything is stored. |
| `desk/` | The only way to make Go think: one queue per trip, a lease so one turn runs at a time, bursts of messages taken together in one turn, and the short wait after a message in case the same person adds more. |
| `composer/` | One model turn: the prompt built cache-first (Go's rules, then the chat in fixed chunks of 25 messages, then "right now", then what is new), a direct Anthropic Messages tool loop of at most 4 rounds within 20 s, a check for new messages just before posting, and `speak.ts`, which shows typing, posts and removes em dashes. Writes take ids from the turn, so a rerun after a crash never posts twice. `room-tools.ts` holds the room's own tools: react, open and close a vote, and update the trip. |
| `reflex/` | Jev, a fast closed-question model, reads each person's message once with nine questions (is it for Go, is the thought complete, is the ask quick or big, which running job it is about, a fact worth saving, a record line, a quiet reaction, is it risky, an opening to help). Every read is logged with numbers only (`reflex_reads`). A question acts only when its labelled test set passed on recorded answers (`live-gate.ts`); until answers are recorded with Go's eval key, all nine run in shadow and code alone decides. `secrets.ts` finds card numbers, codes and passwords by code. |
| `memory/` | Facts about people, each with the message it came from and its history (`facts.ts`); code that checks every proposed fact and record line against its proof (`checker.ts`); a notes pass where a small side model proposes and code decides (`notes.ts`); people's pages drawn from facts; recall over the trip's messages and facts; "the story so far" for long chats (`fold.ts`); a copy of the trip record; the Server's people requests (get, carry-over, delete a fact, forget me) and catch-up for someone who was away; and the quick tools `trip`, `person`, `recall` and `record`. |
| `proactive/` | Speaking first: things Go noticed (a timer, a watch, an opening in the chat) become candidates that pass one bar (`policy.ts`) with a daily budget of 3 unprompted posts per trip, higher bars at night in the trip's time zone, after a hush and after ignored nudges, and never twice in a row with nobody speaking. Only what passes reaches the desk, with the quietest useful action; `notice-tools.ts` holds `post_notice` and `update_notice`. |
| `watches/` | Flight and train status watches for what a trip booked, checked through the travel layer, and `POST /admin/watch/fire`, the demo's labelled simulated watch, guarded by `ADMIN_TOKEN`. |
| `calls/` | `call_business`: Go says who it will call and why in the room, waits 30 s for anyone to say stop (Hinglish included), then dials through Twilio and bridges the call's audio to a realtime voice model. Calls go only to numbers on `CALLS_ALLOWLIST` while the `CALLS_MODE` switch says `allowlist`. The call card updates live with Go's own lines, and the outcome lands in the chat and the trip record. |
| `admin/` | Runtime switches stored in the database (`TRAVEL_MODE`, `PAY_RAIL`, `CALLS_MODE`, `REFLEX_LIVE`), so a demo fallback flips without a redeploy. |
| `db/` | The Postgres pool, the migrator (each lane numbers its own migrations), and `test-db.ts`, which gives every test file its own schema. |
| `testing/` | `start-room.ts`: Go on a real port with every lane registered and the simulator's fake Server connected. The end-to-end tests use it. |
| `travel/`, `tasks/`, `money/` | Interfaces only in this repo for now: travel search, status and booking; long jobs on the trip's own computer; and Go's side of paying. With no travel layer set, watches make no checks, and only the admin fire runs. |
| `stats/` | Empty for now: the place for the turn numbers behind the proof board. |

`room.ts` is the room's own lane (its tools, its "right now" block and Go's hello to a new trip), `env.ts` merges every lane's variables, and `log.ts` is the logger shape the modules share.

## How the tests prove it

Tests live in a `__tests__` folder next to the code they test, and CI runs all of them against a real Postgres. Model calls in tests always go through a scripted fake; Jev, Twilio and the voice model are fakes too.

- **End to end** (`src/__tests__/e2e`, through the simulator's fake Server and the real socket): "@Go ..." shows typing in under 0.5 s and then one answer, chatter gets no typing and no message, a burst of five messages gets one turn, a crash before or right after posting never posts twice, and an answer still goes out once when the Server reconnects mid-turn. `proactive.e2e.test.ts` plays the demo's simulated watch: one labelled notice pinned to Arjun, and a double click posts once.
- **Memory**: a fact needs a message by that same person; a deleted message takes its facts and story lines with it; "forget me" is checked by queries before it answers, including when it lands while a notes pass is reading (`forget-race.test.ts`); people's words stay fenced as data in every prompt.
- **The reflex**: its readers can only raise caution on the risky question, over 2,000 random answer sets (`read.test.ts`); a card number never reaches Jev or the log; a fault in Jev reads "unsure".
- **Speaking first**: the bar, the budget, night in the trip's zone, hushes and the stage's forced fire (`policy.test.ts`, `promoter.test.ts`, `register.test.ts`).
- **Calls**: the 30 s stop window, the allowlist, no card or bank words, one call at a time, and a whole call against a scripted voice model, card updates at most every 3 s and the outcome in the record (`calls/__tests__`).

`pnpm --filter @go/brain test` runs them (it needs `DATABASE_URL`).
