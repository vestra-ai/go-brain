# packages/sim: the simulator

The simulator plays the Server and the people in a trip room, so Go can be built, tested and shown without the real Server or App. It opens the signed socket to Go exactly as the Server does, holds trips in memory with the Server's rules from [`docs/guide`](../../docs/guide), answers all 18 of Go's methods, and sends each trip's events to Go one at a time, in change-number order. The dev room is a one-page App in the browser on top of it.

## Main parts (under `src/`)

| Part | What it does |
|---|---|
| `server-socket.ts` | `GoSocket`, the Server's end of the socket: signs every connect fresh, reconnects with backoff, closes after 40 s of silence, sends unanswered requests again with the same id after a reconnect, and answers Go's requests through a table of handlers with the contract's errors. The Server team can copy this file. |
| `fake-server.ts` | `FakeServer`: trips in memory, Go's 14 writes each done once per `request_id`, and helpers that play people: say, react, edit, delete, tap a card, vote, close a vote on time, and the payer's "Yes, book it" or "Not now". |
| `state/` | The rules behind it: change numbers and events (`trip-state.ts`), votes and mandates (`decisions.ts`), the trip record (`records.ts`), and the spend check, signed spend approvals, bookings, expenses and who owes whom (`money.ts`). A refused write leaves the trip as it was. |
| `dev-room/` | The dev room: a page served with a live WebSocket. It shows the room and every card kind, and sends what people do on the page to the `FakeServer`. It is laid out for a phone. |
| `goa.ts` | The Goa trip from the guide (Rahul, Priya, Arjun, Meher and Kabir), fresh or mid-planning, and a short seed chat. |
| `test-spend-key.ts` | The contract's test Ed25519 key pair, which the simulator uses to sign spend approvals in development and tests. The real Server signs with its own key, which is never in a repo. |
| `cli.ts` | `pnpm --filter @go/sim room -- --go <Go's URL> --secret <GO_SIGNING_SECRET>`: connects to a running Go (the real one or the fake Go), creates the Goa trip and opens the dev room. |
| `try-room/` | The "try Go" room: the dev room behind a passcode, with a fresh Goa trip for each visit and daily caps, made to be hosted on its own. How it works and how to run it are below. |

Go's end-to-end tests (`apps/brain/src/__tests__/e2e`) run against the `FakeServer`, and the fake Go's tests and smoke check connect with `GoSocket` and the Goa trip.

## How the tests prove it

- `server-socket.test.ts`: signed connects, reconnects, requests answered once and sent again after a reconnect, and the keep-alive.
- `fake-server.test.ts`: the upgrade, events in order, a write done once per `request_id` even when it arrives twice, refused writes changing nothing, and a reconnect that keeps the trip.
- `trip-state.test.ts`, `decisions.test.ts`, `records.test.ts` and `money.test.ts`: each of the Server's rules, including the spend check and the money maths.
- `dev-room.test.ts`: one self-contained page with no em dashes and every card kind, laid out for a phone, and what people do on it reaching the room.
- `try-room.test.ts`: the passcode gate (no cookie, a bad or old cookie, a good one, wrong tries slowed while the right passcode always gets in, no secret in any answer), each cap, the socket limits, per-visit trips and person ids, unique ids across restarts, and dropping idle trips.

`pnpm --filter @go/sim test` runs them.

## The hosted "try Go" room

A judge opens the page, types the passcode, and lands in a fresh Goa trip with the five friends, typing as any of them, with the real Go. The try room plays the Server: it signs its socket to Go with `GO_SIGNING_SECRET` on the server side, and the secret never reaches the browser.

- **The gate.** The right passcode gets a cookie (HttpOnly, Secure, SameSite=Strict) that lasts 12 hours, signed with a key made from `TRY_PASSCODE` and the secret `TRY_COOKIE_SALT`, so a cookie that leaks cannot be used to test passcode guesses. Every page, the live socket and every action check it. After 5 wrong tries in a minute from one address, its wrong tries are slowed, and over 30 wrong tries a second from everywhere they are turned away at once; the right passcode always gets in. Pages are never cached, cannot be framed, and run only their own script.
- **A trip for each visit,** with person ids of its own (`p_rahul_<trip>`), so nothing Go learns about a person carries from one visit to another. The trip is made by the visit's first message, so opening the room costs nothing. "Start over" shows a new one, made the same way. Nothing one visit does can reach another visit's trip.
- **The caps,** counted in memory and started again at UTC midnight (05:30 IST). One daily budget of turns covers everything that can wake Go's model: anything said (not only messages that name Go), votes, card taps, the payer's yes or no, and new trips. Each visit has its own share of that budget, keyed to its cookie, so one visit cannot use up the day. A daily total covers everything sent, reactions included. Over a cap the room says so and nothing reaches Go.
- **Staying small.** At most 3 live sockets for a visit and 300 in all, about 5 frames a second from each socket (the rest are dropped, with a note), each trip's state worked out once for every socket watching it, and trips nobody has used or watched for 6 hours dropped.
- **What is live.** The page says whether Go answers at `GO_URL/v1/health`, and says what is simulated.

It runs from `packages/sim/Dockerfile` (built from the repo root) with `packages/sim/railway.json`, which health-checks `/health`. On Railway, leave Root Directory empty and set the config file path to `/packages/sim/railway.json`. The wrong-try limit keys on `x-real-ip`, which Railway's edge sets to the visitor's address, when it is an IP address, and otherwise on the socket's own address; never on `x-forwarded-for`, which a visitor can write. It remembers at most 10,000 addresses, dropping the oldest first, and prunes them every minute. The first passcode that gets in logs, once, which of the two the key came from.

| Variable | What it is |
|---|---|
| `GO_URL` | Go's base URL, such as `https://<Go's domain>`. |
| `GO_SIGNING_SECRET` | The same secret Go has. |
| `TRY_PASSCODE` | What a judge types. At least 20 characters; changing it signs everyone out. |
| `TRY_COOKIE_SALT` | Random and secret, at least 32 characters (`openssl rand -hex 32`). Changing it signs everyone out. |
| `TRY_DAILY_TURNS` | Everything that can wake Go's model, per UTC day, across every visitor. Default 200. |
| `TRY_DAILY_MESSAGES` | Everything sent into the room per UTC day, reactions included. Default 600. |
| `TRY_VISIT_TURNS` | One visit's share of `TRY_DAILY_TURNS`. Default 30. |
| `TRY_SIMULATED_LINE` | The line about what is simulated. |
| `TRY_INSTANCE` | The try room's name on Go's socket. Default `try-room`. |

Railway sets `PORT`. On your machine: `pnpm --filter "@go/sim..." build`, then `GO_URL=... GO_SIGNING_SECRET=... TRY_PASSCODE=... TRY_COOKIE_SALT=... pnpm --filter @go/sim try`, and open http://localhost:8080 (the cookie is Secure, which browsers allow on localhost).
