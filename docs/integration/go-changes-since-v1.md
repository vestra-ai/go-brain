# What changed in Go since v1

This page lists what changed in Go between the v1 hand-off and `build` today (9 Oct, commit `fa68ff8`, #284), and what the Server team and the App team need to do about each change. v1 means contract 1.0.0 in `packages/contract`, the guide in `docs/guide/`, and `main` as of 7 Oct (#173).

## Start here: integrating with Go

Both teams talk to the same Go:

- **Staging Go:** `https://brain-staging-e92c.up.railway.app`. `GET /v1/health` answers `{"ok":true,"contract":"1.1.0"}`, and the socket is `wss://brain-staging-e92c.up.railway.app/v1/socket`.
- **The signing secret** (`GO_SIGNING_SECRET`): ask Keshav. Keep it only in your environment variables, never in code, a chat or a log.
- **The fake Go**, a small stand-in for Go that speaks the real socket with fixed answers: run it on your machine as in `apps/fake-go/README.md`, "Running it on your machine". You make your own secret there with `openssl rand -hex 32`, and it listens on `http://localhost:8080`.
- **The guide**, for people: https://vestrago.vercel.app/docs. For a coding agent: https://vestrago.vercel.app/llms-full.txt, the whole guide as one file. Both were built from `docs/guide/` on 5 Oct and got page 11, Contract 1.1, and the 1.1.0 contract files on 9 Oct. Where they differ from `docs/guide/` in this repo, the repo wins. The exact shapes are in `packages/contract` (zod) and its generated `openapi/go.json`, `asyncapi/socket.json` and `socket/methods.json`.

What is live and what is simulated on staging Go today. These are the switches staging Go is running with, read from its own `GET /admin/health.json` on 9 Oct at 13:52Z. A value set on the admin page is stored in Go's `switches` table and wins over the environment (`apps/brain/src/admin/switches.ts`), so the admin page, not Railway's variables, says what is live.

| Switch | Staging Go now | What it means |
|---|---|---|
| `TRAVEL_MODE` | `ixigo_web` | **Live:** searches read the real ixigo.com in the trip computer's own browser: stays, trains, buses, the ways card, watches and the ixigo login. |
| `TRAVEL_RUNNER` | `browser_fetch` | **Live:** every ixigo.com read goes through Bash's browser fetch on the trip's computer. |
| `PAY_RAIL` | `fake` | **Simulated:** a payment is charged on no rail, so no money moves. Go also never opens ixigo's payment page, and Bash blocks it (section 5). |
| `CALLS_MODE` | `off` | **Off:** Go phones no one. |
| `REFLEX_LIVE` | `q1,q2,q4,q5,q6,q7,q8,q10` | **Live:** these of Jev's quick-read questions act; the others only watch. |
| `BROWSER_FETCH_SLOTS` | `4` | Up to 4 ixigo pages open at once on a trip's computer. |
| `RECIPE_WATCHES` | `on` | **Live:** the group can ask Go to watch ixigo (section 4). |

Go itself is live too: a real model, on the real socket, at contract 1.1.0, with votes, records, expenses, people and "Forget me".

### The Server team (Nishanth's)

1. **Connect and sign.** Prove your signing code against the test vectors, then open the socket to the fake Go on your machine, then to staging Go. Guide page 02, "Connecting" and "Proving your signing code", and page 10, "Prove your signing code first" and "Connect by hand". For your end of the socket, copy `packages/sim/src/server-socket.ts` (`apps/fake-go/README.md` says why).
2. **Send events and answer Go's requests.** Send `send_event` for each change in a trip with the next change number (guide page 03), and answer Go's requests (`read_trip`, `post_message`, `replace_card` and the rest, page 04). Run the fake Go's smoke check until it prints `SMOKE OK` (`apps/fake-go/README.md`).
3. **Forward taps and take 1.1.** Forward every `card_tap` with its `action_id` as it is, and give the App Go's answer (guide page 05, "Card taps"). Accept the 1.1 additions you store, such as `quick_replies` on `post_message` and the `checklist` card (guide page 11, Contract 1.1).

### The App team (Saket's)

1. **Draw Go's messages and cards.** Every card kind, its buttons, and what to show for a kind you don't draw yet (`fallback_text`). Guide page 06 (Cards) and page 07 (The App), "Drawing Go's messages".
2. **Send taps and open what Go opens.** A tap goes through the Server as `card_tap`. An `open` answer is a link to show at once in its own browser view: an ixigo page, the vault, or Go's screen for the ixigo login (section 1 below). Guide page 07, "Buttons on Go cards" and "Opening Go pages".
3. **The 1.1 screens.** Option details, round trips, quick replies, "I'm flexible", checklists and the rest: guide page 11 (Contract 1.1) lists each addition and where it lives. Every one is optional, so a 1.0 screen keeps working while you add them.

## In short

- **The contract is now 1.1.0** (#263, `CONTRACT_VERSION` in `packages/contract/src/index.ts`; guide page 11, `docs/guide/11-contract-1-1.md`). 1.1 only adds: new optional fields, new values, new event types and new card kinds. Nothing is renamed or removed, so a Server or App built for 1.0 keeps working. Staging Go answers `"contract": "1.1.0"`.
- Go sends no new methods. It still uses `post_message`, `replace_card` and the rest exactly as the guide describes them, with 1.1's optional fields.
- The other changes are in how Go uses the contract: new button ids on existing cards, the ixigo login card on Go's hello, a new "ways there" options card, watches that post later, a new read-only socket `/v1/live`, new setup steps, and two new switches.
- The Server forwards every `action_id` as it is (guide page 05), so the new buttons need no Server code.

## 1. Card buttons and `open` answers

These are all the buttons Go handles today (`travel/taps.ts`, `travel/login.ts`, `tasks/taps.ts`, `money/register.ts`, `calls/register.ts`):

| Card | `action_id` | Label | What Go answers | Since |
|---|---|---|---|---|
| `options` | `pick` (per option) | "I'll take this" | `done`, and Go replies in the room. | v1 |
| `options` | `vote` | "Put it to a vote" | `done`, and Go opens the vote. | v1 |
| `options` | `open` (per option) | "See on ixigo" | `open` with that option's own ixigo.com page. | In `main`, but not in the guide |
| `options` | `see_all` | "See all on ixigo" | `open` with the whole stays list on ixigo.com. | New, #194 |
| `options` | `flights_home` | "Flights from my city" | `open` with ixigo's flights from the tapper's home city. | New, #208 |
| `notice` | `see_on_ixigo` | "See flights on ixigo" (or trains, buses, hotels) | `open` with the card's `source.url` on ixigo.com. | Flights card in `main`, other kinds new in #179 |
| `notice` | `ixigo_login`, `ixigo_logged_in`, `ixigo_not_now`, `ixigo_logout` | See "The ixigo login card" below | `done` with a toast. | New, #220 |
| `notice` | `ixigo_watch` | "Watch", on the login card only | `open` with a 15-minute link to Go's screen, in control, for the person logging in only. | New, #247 |
| `working` | `watch`, `stop` | "Watch", "Stop" | `watch` answers `open` with a 15-minute screen link. | v1 |
| `call` | `stop` | "Stop the call" | `done`. | v1 |
| `pay` | `approve`, `decline` | "Approve", "Decline" | `approve` answers `open` with the vault page (5 minutes). | v1 |

What to do:

- **Server:** pass the tap and Go's answer through unchanged. Nothing new is needed.
- **App:** open every `open` URL at once in the system browser sheet (`LaunchMode.inAppBrowserView`), as guide page 07 says. The URL can now be a `www.ixigo.com` page, not only one of Go's own pages.
- **App:** show the toast on every `refused` answer, such as "That option is no longer here" or "This list has no ixigo page".

Which card gets which buttons (`travel/cards.ts`):

- A normal options card has `pick`, then `vote` when it has two or more options, then one of these. Stays read from ixigo.com get `see_all`. Any other card whose options have ixigo pages gets `open`.
- The ways card (section 2) has only `open` and `flights_home`. It has no `pick` and no `vote`.
- A notice card that links to ixigo has one `see_on_ixigo` button.

Good to know:
- For an ixigo page, `expires_at` is 10 minutes after the tap (`OPEN_FOR_MS` in `travel/taps.ts`). It is how long Go counts the prices as fresh. The page itself keeps working, but do not keep the link: a later tap gets a fresh answer.
- Go answers a tap within 2.5 seconds (`door/taps.ts`). A button Go has no handler for is refused with "That button doesn't do anything yet."

### The ixigo login card

One person logs in to ixigo on the trip's computer, so Go can later search and book with a login (`apps/brain/src/travel/login.ts`). Since #247 there is no job and no model in it: Go opens ixigo's page itself and hands it to the person.

- **Who gets it:** the trip's organizer (`organizer_person_id`), or, if the organizer has paused Go, the first person in the trip who hasn't. Only under `TRAVEL_MODE=ixigo_web`. The card's `for_person_ids` and every button's `only_for_person_ids` hold that one person, so only they see its buttons.
- **When Go asks:** on Go's own hello to a new trip. The hello's last line names them ("<name>, first link ixigo once so I can search and book for everyone.", `HELLO_LINE`) and the card rides on the same message (`helloCard`), so the Server sees one Go message, not two. If the hello went without it, the setup step `travel.ixigo_login` asks after the hello. A trip Go set up before this is asked at its first search instead. Every trip is asked this way once: a login row of any kind, "Not now" included, means no more of these asks.
- **When Go asks again:** when a recipe marked `auth: login` needs the login, at most once every 30 minutes, with a new line and a new card. The card id is `c_login_<trip_id>_<attempt>`.
- **How the card moves:** Go updates it in place with `replace_card`. Its states and buttons (`loginCard` in `travel/login.ts`):

| Card title | Buttons | When |
|---|---|---|
| "Link ixigo for this trip" | `ixigo_login` "Log in to ixigo", `ixigo_not_now` "Not now" | The ask. Its body changes when Go couldn't open the page, when the page waited 10 minutes, or for ixigo's Cloudflare check (below). |
| "Logging in to ixigo" | `ixigo_logged_in` "I'm logged in", `ixigo_not_now` "Not now" | Right after "Log in to ixigo", while Go brings ixigo's page in front ("Opening ixigo's log in on Go's screen for <name>."). No Watch yet. |
| "Logging in to ixigo" | `ixigo_watch` "Watch", `ixigo_logged_in` "I'm logged in", `ixigo_not_now` "Not now" | The page is in front on Go's screen and theirs to use. |
| "Logging in to ixigo", tone `heads_up` | the same three | "I'm logged in" found no login yet: "Not logged in yet. Finish on Watch, then tap again." |
| "ixigo: logged in as <name>" | `ixigo_logout` "Log out" | Logged in. The card names the trip member, never the account. |
| "ixigo login skipped" | `ixigo_login` "Log in to ixigo" | After "Not now": "Go will ask again when a booking needs it." |
| "Logged out of ixigo" | none | After "Log out", or when the person left the trip or used "Forget me". |

- **What each tap answers** (`registerTaps` in `travel/login.ts`): `ixigo_login` answers `done` with "Opening ixigo's log in on Go's screen" (a second tap while it opens: "Already opening ixigo's log in"). `ixigo_watch` answers `open` with Go's screen (below). `ixigo_logged_in` answers "Checking your login", then Go updates the card. `ixigo_not_now` answers "Go will ask again when a booking needs it". `ixigo_logout` answers "Logging out of ixigo". Anyone else's tap is refused with "Only <name> can do this here.", and a tap on a card that is no longer active with "That login card is not active any more."
- **How the person logs in:** "Log in to ixigo" opens ixigo's page in front on the trip's computer, at a phone's size, with its Login and mobile number box tapped, and keeps it there for 10 minutes (`HANDOFF_MS`). Then the card gets Watch. Watch is the person's alone: its `open` link is a 15-minute session on Go's screen in control mode, cropped to that one page. **Open it in its own browser view** (the App's system browser sheet; the try room opens it in a new tab in the tap itself, `packages/sim/src/dev-room/page.ts`). On that page they type their own mobile number and the one-time code. Go never sees either, and nobody else can watch them type.
- **What "I'm logged in" checks:** ixigo's own answer, not anything the person says. Go loads ixigo's page again in the same tab and catches the calls ixigo's own code makes as it loads, one byte each, by their status only (`LOGIN_CALLS`, `loginFrom`): the wallet (`/api/v3/ixigo-money/wallet`) or `/api/profile/secure/booking/with-identity` answering 200 means logged in, any of those or `/api/v2/oauth/userinfo` answering 401 or 403 (a token ixigo refuses) means not, anything else means Go can't tell. Logged in: the tab closes and the card says so. Not yet: the page stays in front for them and the card turns `heads_up`. A login is checked again at most every 6 hours, when a recipe needs it; one ixigo no longer has is let go (the card says Go's computer is no longer logged in) and the next booking asks again.
- **ixigo's Cloudflare check:** now and then ixigo answers a page load with Cloudflare's "Just a moment..." check instead of the page (about 1 in 7 loads on a staging computer, `travel/recipes/runners.ts`). Go loads such a page again, up to 2 more times, never reads it and never hands it to a person (#284). If it is still on the check, the tab closes and the card goes back to its ask with "ixigo asked Go's computer to wait a moment before its log in. Tap Log in to ixigo to try again in a minute." A search that meets it says "ixigo asked the trip's computer to wait a moment. Try again in a minute." (`CHALLENGED`).
- **Logging out:** Go logs out (ixigo's own menu) when the person taps "Log out", leaves the trip (`person.left`), or uses "Forget me" in the trip.
- **What the Server and App do:** the Server forwards the taps and applies `replace_card`, and pushes the person for the mention and the pin. The App shows the buttons only to `only_for_person_ids`, shows the toasts, draws a `heads_up` card as one, and opens Watch's link in its own browser view at once.

## 2. The comparison card is an ordinary options card

- There is no new card kind. When people ask how the group gets to the trip, Go runs `compare_ways_there` (`travel/ways-there.ts`, #208, #214) and posts one `options` card built by `buildWaysCard` in `travel/cards.ts`. It passes the contract's `OptionsCard` check like every options card.
- Each row is one home city's cheapest or fastest train or bus, with five rows at most. A row's title reads "From Jaipur: <train or bus>", and its first highlight says which it is, such as "Cheapest, 5h 20m".
- One card can mix trains and buses. `option_kind` is `train` unless every row is a bus, so draw each row from its own `journey.mode`.
- The rows have no photos, so `image_url` is absent.
- While the comparison runs (about 25 seconds for three cities), Go posts "On it." with a `working` card titled "Checking 3 cities", with one step per city and no buttons. If the comparison takes longer than the turn, Go posts the options card and its line as a new message when it is in.
- The App needs no new kind, layout or handler. It only must not assume that every options card has `pick` and `vote`.

## 3. `/v1/live` (Go Live)

- **What it is:** a read-only WebSocket on Go's port (`travel/live.ts`, #195, #196, #209). It streams one trip's ixigo work as it happens: each recipe run with its calls, steps and timings, and the pages open in the trip computer's browser as live pictures, from Bash's browser watch (`travel/screen-feed.ts`).
- **Who calls it:** today only Go's own try room (`packages/sim/src/try-room/live-feed.ts`, with `TRY_LIVE=1`). The Server may open it to show Go Live. It is optional for integration, and it is not part of the contract.
- **Auth:** it uses the same `x-go-signature` as `/v1/socket`, signed with `GO_SIGNING_SECRET` over `GET` and the path plus query. Each signature works once. Connect to `/v1/live?trip_id=<trip>&n=<random>`. Go ignores `n`, but it makes two opens in the same second sign differently. A bad signature gets `401`, and a malformed trip id gets `404`.
- **Who may hold the secret:** only the Server. The App must never hold it, so if the App shows Go Live, the Server relays the stream.
- **What it streams:** JSON messages. The first is `{ "type": "hello", "trip_id", "events", "screen" }`, with recent run events and the screen as it is now. After that, each message is `{ "type": "run", "event" }` (run_start, call, step, run_end, frames, group_end) or `{ "type": "screen", "event" }` (state, tab_open, frame, hidden, tab_close).

Good to know:
- Pictures are 1280 pixels wide (#219). Go asks Bash for that width on every page it fetches and on the browser watch (`FRAME_WIDTH` in `travel/recipes/runners.ts`). A `frame` event carries its `width` and `height`. Draw a picture at its own size or smaller, never stretched, as the try room does (`packages/sim/src/dev-room/live-page.ts`). The live search card's `screenshot_url` comes from the same pictures.
- Pictures are sent only of ixigo.com search, results and details pages (`travel/frame-pages.ts`), and only with the page's path, never its query. A payment, booking or sign-in tab shows as `hidden`.
- Watching never wakes the trip's computer. While it sleeps, the screen state is `asleep`. Outside `TRAVEL_MODE=ixigo_web`, the screen state is `off`.
- Go keeps this in memory only: the last 300 events per trip and the pictures of the newest 4 runs. A slow viewer misses pictures, never run or tab events. Go ignores anything a viewer sends.
- The message shapes are Go's own (`travel/runs.ts`, `travel/book/run-event.ts`, `travel/screen-feed.ts`) and may still change.

## 4. Watches ("tell us when it confirms")

- **What they are:** a person asks Go to keep an eye on ixigo, such as "tell us when 12608's waitlist confirms" or "tell us if the bus goes under ₹900". The composer calls `watch_ixigo`, and `stop_watch` stops one (`travel/watch-tools.ts`, #211, #215, #217).
- **When it starts:** Go checks once straight away. If it is already true, Go says so and keeps no watch. Otherwise Go says in one line how often it will check and until which day.
- **The checks:** Go checks every hour, and every 30 minutes within two days of the date (`travel/recipe-watches.ts`). A trip has at most 3 watches, and a watch runs at most 14 days. A watch ends at its date, when someone stops it, after 6 failed checks in a row (Go says so in one line), or when the trip is gone.
- **What the Server sees when it comes true:** a normal Go message. The watch goes through Go's proactive path as a candidate marked `asked: true`, and Go sends `post_message` with one short line and a `notice` card with source "ixigo". There is no new method, no new card kind and no button. Go says it once.
- **What else the Server sees:** checks run in the background and need the Server's socket open. No check runs while it is down (#217). For a quiet trip, a check may make Go send `read_trip` and `read_messages`. Answer them as usual.
- **Switch:** watches need `RECIPE_WATCHES=on` and `TRAVEL_MODE=ixigo_web`. With either one off, Go tells the person it does not watch ixigo here yet and offers to search now.
- **For ops:** `GET /admin/health.json` (behind the admin token) now has `watches`, which lists each trip's active watch count and next check time, with no watch ids. It also has `recipes`, with each recipe's runs, failures, p50 and p90. The admin page (the stage desk) shows both tables.

Good to know: because the group asked, a watch's message skips Go's daily budget for unprompted posts and its "two in a row" rule (`proactive/policy.ts`). It still waits out the night and still goes out once only.

## 5. Setting up a new trip

Setup runs on `trip.created` and on any event for a trip that is not set up yet (`trips/intake.ts`). It runs these steps in this order (`trips/setup.ts`, with the lanes registering in the order of `main.ts`). A step with "after" waits until that step is done.

| Order | Step | Where | What it does |
|---|---|---|---|
| 1 | `brain.ready` | `room.ts` | Makes Go's side of the trip, then Go says hello. |
| 2 | `travel.computer` | `travel/warm.ts`, #198 | Starts the trip's computer, with no hold. It never waits for the computer to wake. |
| 3 | `travel.ixigo_login`, after `travel.computer` | `travel/login.ts`, #220, #227 | Go's hello normally carries the login ask already (section 1); then this step asks nothing. If the hello went without it, it asks right after the hello, looking for the hello every second for up to 20 seconds. |
| 4 | `travel.ixigo_warm`, after `travel.computer` | `travel/warm.ts`, #218 | The computer's browser visits ixigo's home page once and closes its popup, so the first search is not its first visit. The login line never waits for it. |
| 5 | `computer.user` | `tasks/computer.ts` | Makes the trip's `/v1` user, if step 2 has not already made it. |

- Steps 2, 3 and 4 do anything only under `TRAVEL_MODE=ixigo_web`. In the other modes they finish at once.
- The login ask now rides on Go's hello message, so it lands with the hello. If the step has to ask and there is still no hello after 20 seconds, it fails and is tried again.
- A step that fails is tried again on the trip's next event (at most every 30 seconds) or by setup's sweep (every 2 minutes).
- `travel.ixigo_warm` tries at most 3 times (`IXIGO_WARM_TRIES`, counted per Go process). After that it is done with a warning. Its runs show as a `travel.ixigo_warm` line in `recipes` on `/admin/health.json`.
- The old `computer.warm` step is gone (#183). After setup, the computer wakes only when someone asks for travel, a job starts, or a watch is checked.
- The Server provides nothing new. It sends `trip.created` as before, and Go still answers `accepted` at once and sets up afterwards. Under `ixigo_web`, Go's hello carries the login line and its card in one message. A trip set up before this gets the ask at its first travel ask instead.
- Go's `/v1` deployments now allow `ixigotrainsapi.confirmtkt.com` next to `ixigo.com` (#204), and block `ixigo.com/payments/` (#181, commit `6ac6194`, enforced by Bash #4591). These live in `tasks/instructions.ts` and are written by the one-time `setup-v1` script (`pnpm --filter ./apps/brain setup-v1 --browser-fetch`), not by a per-trip step.
- When Bash blocks a page, Go refuses it with "That's the payment page, and Go never opens it; the payer finishes on ixigo." Go never pays on ixigo.
- `setup-v1` now checks every model it is given against `GET /v1/models` before it saves anything. If `/v1` does not offer one, the run stops and saves nothing (#221).

Good to know: `setup-v1` must run against a Bash that has #4591, because `/v1` refuses a manifest key it does not know. #221's notes say staging was run this way on 8 Oct.

## 6. Switches

Switches are read on every use, and a value set on the admin page wins over the environment variable, which wins over the default (`admin/switches.ts`).

| Switch | Values | Default in code | What it does |
|---|---|---|---|
| `RECIPE_WATCHES` (new) | `off`, `on` | `off` | Turns watches on (section 4). `.env.example` says staging sets `on` and production leaves it `off`. |
| `BROWSER_FETCH_SLOTS` (new) | `1` to `4` | `2` | Sets how many ixigo pages Go opens at once on a trip's computer. Match Bash's own cap. It also sets how long a comparison may take. |
| `TRAVEL_RUNNER` | `agent_job`, `browser_fetch` | `agent_job` | Does nothing now. Since #184 every ixigo.com read uses Bash's browser fetch, but the switch still shows on the admin page. |
| `TRAVEL_MODE` | `ixigo`, `ixigo_web`, `fake` | `fake` | Unchanged. `ixigo_web` is the mode that turns on Go Live's screen, watches, the ways card, the computer and ixigo warm at setup, and the login card. |

## Other changes you may notice

- For a plain search ask, Go now posts the options card and its line with no extra model round (#194). In the drills that was about 15 seconds sooner, and the messages have the same shape as before.
- The live search card (a `working` card posted with "On it.") can start with a step like "Choosing between Udaipur City (UDZ) and Udaipur Junction (UDPU)" (#207). A card that a finished turn left open now ends as `failed` (#177). These cards have no buttons, and their `task_id` is not a job.
- For a place Go has no ixigo code for, Go posts a notice card that opens ixigo's own search page (#179). Go never names another booking site (`composer/rules.ts`).
- A question put to Go now gets Go's answer instead of a ✅ or an open record line (#174). A quiet 👍 or 🙌 from Go now comes 3 seconds after the line it answers.
- Card titles name the day more often, such as "Trains, Delhi to Goa, 6 Nov" (#188, #202).
- Under `ixigo_web`, a flights search can now answer with an options card of flights read from ixigo's page (airline and flight numbers, times, stops, the fare per person), the same card trains and buses get. ixigo refuses our boxes' shared address when it sees too many flights pages, so Go loads at most one flights page every 20 seconds across all trips, and none for 10 minutes after ixigo refuses one. Then, and when the page shows nothing, Go posts the flights link card as before. The ways card can now have flight rows, and a city whose flights didn't come back says "Fastest by train or bus".

## Where the guide is now out of date

- **06-cards.md, "Buttons on Go cards":** the table lacks `open`, `see_all` and `flights_home` on options cards, and `see_on_ixigo` and the four login buttons on notice cards. It says `open` is only for the vault and watching Go work. Its notice card section says "usually none" for buttons, but link cards and the login card have them.
- **05-your-requests.md, the `card_tap` table:** it lacks the same buttons.
- **07-the-app.md, "Opening Go pages":** it says every link is one of Go's pages and expires after 5 minutes. ixigo links are `www.ixigo.com` pages and expire after 10 minutes.
- **03-events.md, "How Go sets itself up for a new trip":** it says Go starts a computer for every trip. Now that happens only under `ixigo_web`, with no hold, followed by the ixigo warm and the login line.
- **08-money-and-the-vault.md, "What it holds":** it says the vault holds logins, such as a person's ixigo account. The vault stores no logins this week (`apps/vault/src/links.ts`), and the ixigo login now lives in the trip computer's browser (#220).
- **docs/operations.md, "The demo switches":** it lists four switches and gives `TRAVEL_MODE` as `ixigo` or `fake`. There are now seven switches, and `TRAVEL_MODE` also takes `ixigo_web`.
- No guide page covers `/v1/live`, watches or the ixigo login; this page does.
- Guide page 11 (Contract 1.1) is the guide's own page for 1.1, and the live guide has it (https://vestrago.vercel.app/docs, "Contract 1.1").
