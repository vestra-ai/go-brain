# What changed in Go since v1

This page lists what changed in Go between the v1 hand-off and `build` today (8 Oct, commit `6eaf68c`, #217), and what the Server team and the App team need to do about each change. v1 means contract 1.0.0 in `packages/contract`, the guide in `docs/guide/`, and `main` as of 7 Oct (#173).

## In short

- The contract did not change. `git diff origin/main origin/build -- packages/contract packages/contract-py docs/guide` is empty, and `CONTRACT_VERSION` is still `1.0.0`.
- Go sends no new methods. It still uses `post_message`, `replace_card` and the rest exactly as the guide describes them.
- The changes are in how Go uses the contract: new button ids on existing cards, a new "ways there" options card, watches that post later, a new read-only socket `/v1/live`, a changed setup, and two new switches.
- The Server forwards every `action_id` as it is (guide page 05), so the new buttons need no Server code.

## 1. Card buttons and `open` answers

These are all the buttons Go handles today (`travel/taps.ts`, `tasks/taps.ts`, `money/register.ts`, `calls/register.ts`):

| Card | `action_id` | Label | What Go answers | Since |
|---|---|---|---|---|
| `options` | `pick` (per option) | "I'll take this" | `done`, and Go replies in the room. | v1 |
| `options` | `vote` | "Put it to a vote" | `done`, and Go opens the vote. | v1 |
| `options` | `open` (per option) | "See on ixigo" | `open` with that option's own ixigo.com page. | In `main`, but not in the guide |
| `options` | `see_all` | "See all on ixigo" | `open` with the whole stays list on ixigo.com. | New, #194 |
| `options` | `flights_home` | "Flights from my city" | `open` with ixigo's flights from the tapper's home city. | New, #208 |
| `notice` | `see_on_ixigo` | "See flights on ixigo" (or trains, buses, hotels) | `open` with the card's `source.url` on ixigo.com. | Flights card in `main`, other kinds new in #179 |
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

**The ixigo login card is not on `build`.** It is draft PR #220 (branch `ixigo-login`) and may change before it merges. In that draft, the login card is a `notice` card pinned to one person, with the buttons `ixigo_login`, `ixigo_not_now`, `ixigo_logged_in` and `ixigo_logout`. All four answer `done` with a toast, never `open`. The person logs in through the existing working card's Watch button, which answers `open`.

Good to know:
- For an ixigo page, `expires_at` is 10 minutes after the tap (`OPEN_FOR_MS` in `travel/taps.ts`). It is how long Go counts the prices as fresh. The page itself keeps working, but do not keep the link: a later tap gets a fresh answer.
- Go answers a tap within 2.5 seconds (`door/taps.ts`). A button Go has no handler for is refused with "That button doesn't do anything yet."

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

- A new trip now runs three setup steps (`trips/setup.ts`). `brain.ready` makes Go's side of the trip and says hello (`room.ts`). `computer.user` makes the trip's `/v1` user (`tasks/computer.ts`). `travel.computer` makes the trip's computer (`startComputerAtSetup` in `travel/warm.ts`, #198).
- The old `computer.warm` step is gone (#183). Under `TRAVEL_MODE=ixigo_web`, `travel.computer` makes the computer with no hold, so the first search does not wait about 13 seconds for it. In the other modes it does nothing. After setup, the computer wakes only when someone asks for travel, a job starts, or a watch is checked.
- The Server provides nothing new. It sends `trip.created` as before, and Go still answers `accepted` at once and sets up afterwards.
- Go's `/v1` deployments now allow `ixigotrainsapi.confirmtkt.com` next to `ixigo.com` (#204), and block `ixigo.com/payments/` (#181, commit `6ac6194`, enforced by Bash #4591). These live in `tasks/instructions.ts` and are written by the one-time `setup-v1` script (`pnpm --filter ./apps/brain setup-v1 --browser-fetch`), not by a per-trip step.
- When Bash blocks a page, Go refuses it with "That's the payment page, and Go never opens it; the payer finishes on ixigo." Go never pays on ixigo.

Good to know: `setup-v1` must run against a Bash that has #4591, because `/v1` refuses a manifest key it does not know.

## 6. Switches

Switches are read on every use, and a value set on the admin page wins over the environment variable, which wins over the default (`admin/switches.ts`).

| Switch | Values | Default in code | What it does |
|---|---|---|---|
| `RECIPE_WATCHES` (new) | `off`, `on` | `off` | Turns watches on (section 4). `.env.example` says staging sets `on` and production leaves it `off`. |
| `BROWSER_FETCH_SLOTS` (new) | `1` to `4` | `2` | Sets how many ixigo pages Go opens at once on a trip's computer. Match Bash's own cap. It also sets how long a comparison may take. |
| `TRAVEL_RUNNER` | `agent_job`, `browser_fetch` | `agent_job` | Does nothing now. Since #184 every ixigo.com read uses Bash's browser fetch, but the switch still shows on the admin page. |
| `TRAVEL_MODE` | `ixigo`, `ixigo_web`, `fake` | `fake` | Unchanged. `ixigo_web` is the mode that turns on Go Live's screen, watches, the ways card and the computer at setup. |

## Other changes you may notice

- For a plain search ask, Go now posts the options card and its line with no extra model round (#194). In the drills that was about 15 seconds sooner, and the messages have the same shape as before.
- The live search card (a `working` card posted with "On it.") can start with a step like "Choosing between Udaipur City (UDZ) and Udaipur Junction (UDPU)" (#207). A card that a finished turn left open now ends as `failed` (#177). These cards have no buttons, and their `task_id` is not a job.
- For a place Go has no ixigo code for, Go posts a notice card that opens ixigo's own search page (#179). Go never names another booking site (`composer/rules.ts`).
- A question put to Go now gets Go's answer instead of a ✅ or an open record line (#174). A quiet 👍 or 🙌 from Go now comes 3 seconds after the line it answers.
- Card titles name the day more often, such as "Trains, Delhi to Goa, 6 Nov" (#188, #202).

## Not on `build` yet

These are open PRs, and each one may change before it merges:
- #220 (draft): the ixigo login card from section 1.
- #218: a new setup step, `travel.ixigo_warm`, that opens ixigo on the new computer.
- #212: Go Live labels each live tab with the run that opened it.
- #219: sharper Go Live pictures, 1280 pixels wide.

## Where the guide is now out of date

- **06-cards.md, "Buttons on Go cards":** the table lacks `open`, `see_all` and `flights_home` on options cards and `see_on_ixigo` on notice cards. It says `open` is only for the vault and watching Go work. Its notice card section says "usually none" for buttons, but link cards have one.
- **05-your-requests.md, the `card_tap` table:** it lacks the same four buttons.
- **07-the-app.md, "Opening Go pages":** it says every link is one of Go's pages and expires after 5 minutes. ixigo links are `www.ixigo.com` pages and expire after 10 minutes.
- **03-events.md, "How Go sets itself up for a new trip":** it says Go starts a computer for every trip. Now that happens only under `ixigo_web`, with no hold.
- **docs/operations.md, "The demo switches":** it lists four switches and gives `TRAVEL_MODE` as `ixigo` or `fake`. There are now seven switches, and `TRAVEL_MODE` also takes `ixigo_web`.
- No guide page covers `/v1/live` or watches.
