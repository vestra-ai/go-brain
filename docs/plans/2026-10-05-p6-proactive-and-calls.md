# P6: Go speaks first, and calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Go speaks up on its own when it truly helps (timers, watches, openings in the chat), always through one bar, one budget and the quietest useful action, and Go phones a business for the group live, with a 30 second chance to stop it, a call card updated in place and the outcome in the chat and the record.

**Architecture:** Everything Go notices on its own (a timer coming due, a watch that saw a change, an opening in the chat or a trip change) becomes a row in `proactive_candidates` keyed by a stable dedupe key, so a nudge can never repeat. A promoter, every 15 seconds, runs due candidates through the pure policy (`proactive/policy.ts`: importance × confidence × urgency against bars that rise at night in the trip's time zone, after a hush and after ignored nudges; about 3 unprompted posts per trip per day; never two in a row without a person speaking; small things batched) and only a candidate that passes is put on the desk (kind `timer`, `watch` or `opening`) with the actions the bar allowed. The composer still picks the words; the wake text, the `openings` "right now" block and P6's own notice tools enforce what is allowed. Calls are their own service: `call_business` posts one line and waits 30 seconds in the `calls` table, then dials through Twilio's REST API with a `<Connect><Stream>` to Go's media socket, which bridges Twilio's μ-law frames to the realtime voice model over a plain WebSocket (`audio/pcmu` both ways), keeps the call card live (at most one update every 3 seconds), and closes out with the outcome message and, when it settles something, an `add_record_line` whose proof is the call card's message.

**Tech Stack:** Node 22, TypeScript strict (`exactOptionalPropertyTypes`), zod 4.3.6, Fastify 5, `ws` 8 (Go's media socket and the client socket to the realtime model; no `openai` SDK because the repo pins `openai` 6.39.1 for the copied agent loop), `pg` 8, `@go/contract` 1.0.0, vitest 4 with the CI Postgres service, Twilio Programmable Voice REST + Media Streams over `fetch` (no `twilio` SDK), the realtime voice model `gpt-realtime-2.1` over `wss://api.openai.com/v1/realtime`.

**Spec:** `docs/spec/2026-10-05-go-design.md` §5 (timers), §8 (being proactive), §12 (status for watches), §14 (calls), §2 (watches, calls) and `docs/plans/2026-10-05-go-the-week.md` (master plan; sections 6 and 7 are binding). Cards: `docs/guide/06-cards.md` (call, notice); the call flow: `docs/guide/09-flows.md` §5.

**Lane / gate:** Lanes A (proactive, Tasks 1 to 8) then C (watches already in Tasks 7 and 8; calls, Tasks 9 to 14). Gate **G5 "Go speaks first, and calls", Thu 23:00**: timers, watches, the proactive bar and budget pass in CI; one real call to a teammate's phone with the live card and the outcome. Demo beats served (master §1): **3:00 "the call"** and **3:40 "proactive and safe"** (the labelled simulated watch: the flight is 2 hours late and Arjun's cab is at 9; Go suggests moving it, pinned to Arjun).

**Depends on:**
- P1: `Brain`, `RegisterLane` (`apps/brain/src/app.ts`); `Desk.put`, `DeskItem`, `DeskKind` (`desk/desk.ts`); `Context.addNow`, `Context.addWake`, `NowProvider` (`composer/context.ts`); `Tools.register`, `QuickTool`, `TurnCtx`, `TurnOutcome` (`composer/tools.ts`); `MessageHooks.onRead` (`trips/hooks.ts`); `TripLog.onEvent` (`trips/log.ts`); `Packs.get`, `TripPack` (`trips/pack.ts`); `TapRouter.on('call', 'stop', ...)` (`door/taps.ts`); `ServerLink.request`, `newRequestId()` (`door/server-link.ts`); `Message`, `Trip`, `TripEvent`, `CardTapParams`, `CardTapResult` (`door/methods.ts`); `Switches.get('CALLS_MODE')` (`admin/switches.ts`); `withSchema()` (`db/test-db.ts`); the `trips` table (`trip_id`, `last_seq`, `tz`) and `trip_events.received_at`; `Env` with `GO_PUBLIC_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `OPENAI_API_KEY`, `CALLS_MODE`, `CALLS_ALLOWLIST`, `ADMIN_TOKEN` (all optional strings).
- P2: `ReflexRead` with `opening: Sure<boolean>` and `forGo: Sure<boolean>` (`reflex/reflex.ts`; P1's stub until P2 lands); the quick tools named `react`, `record`, `trip`, `person`, `recall`; P1's `stay_silent`.
- P4: `Travel.status(q: StatusQuery): Promise<StatusResult>` (`travel/travel.ts`); P6 builds and reads those shapes in one file, `watches/port.ts` (see the interface notes).
- `@go/contract`: `TripSnapshot`, `Message`, `Event`, `NoticeCard`, `CallCard`.

## Global Constraints

Master §7 applies to every task. Specific to this plan:
- Calls go only to numbers in `CALLS_ALLOWLIST` (comma separated, each `+E164` or `Name=+E164`), and only while the `CALLS_MODE` switch reads `allowlist`; it is read again just before dialing.
- The stop window is exactly 30 s (`CALL_WINDOW_MS = 30_000`); a call is hung up at 4 minutes (`CALL_CAP_MS = 240_000`); Twilio's own `TimeLimit` is 255 s as a backstop.
- The call card is updated at most once every 3 s (`CARD_GAP_MS = 3_000`); the final card always lands.
- The voice model hears the business itself; the business's lines come from the same realtime session's own input transcription. No separate speech-to-text service (Keshav's ruling).
- The call never pays: the session instructions forbid paying and sharing card, bank or UPI details, and `call_business` refuses a goal or fact that carries card, bank, OTP or password words or a long run of digits.
- On the call Go says it is an AI assistant in its first line and never names the model or its vendor; every string Go posts passes `plain()` (no em dashes, vendor names replaced with "Go").
- Night is 22:00 to 08:00 in the trip's time zone (`trips.tz`, default `Asia/Kolkata`).
- At most 3 unprompted posts (a pinned notice or a message to everyone) per trip per local day (`DAILY_POSTS = 3`).
- Every card from a simulated watch carries `source: { name: "Simulated for the demo" }`.
- Every call write uses a deterministic `request_id`: `go_<call_id>_<step>` (`announce`, `card`, `cancel`, `off`, `outcome`, `record`, `fail`), so a crash and re-run never doubles a post.
- Audio is never recorded or stored; only the transcript (at most 300 lines) is kept, on the call card and in `calls.transcript`.
- `ADMIN_TOKEN` guards `POST /admin/watch/fire`; without it the route answers 404.

## Review Focus

1. **Go speaks up at the wrong moment**: at 23:30 in Goa, a fourth time in a day, twice in a row with nobody speaking in between, after a "Go chup kar", or pinging someone who paused Go. (Task 1 policy tests; Task 4 promoter tests for night and budget through the database; Task 6 hush test.)
2. **A nudge repeats**: the same timer re-planned on every event, the same flight delay read twice by a watch, a vote reminder after the vote already closed. (Task 2 "never re-added"; Task 3 replan tests; Task 4 stale-candidate drop; Task 8 runner dedupe.)
3. **Go calls when it must not** (includes master §10.3, someone steering Go): a number off the allowlist, `CALLS_MODE` flipped to `off` inside the window, "ruk jao", "band karo", "stop" or a "nahi" reply inside the window, a second call while one is live, "call the villa and give them Rahul's card 4111 1111 1111 1111". (Task 9 stop words; Task 12 service tests.)
4. **The call card lies**: stuck on talking after the business hangs up, a crash mid-call, the 4 minute cap, a Stop tap after the end (must answer "The call has already ended."), a media connection with a wrong token (must end nothing). (Task 11 bridge tests; Task 12 sweep and tap tests; Task 13 end to end.)
5. **The demo's simulated watch looks real or never lands**: the notice must say "Simulated for the demo", be pinned to Arjun only, and arrive within a second of the admin tap; the route must refuse without the admin token. (Task 5 notice tool tests; Task 8 admin and demo-beat test.)

## File Structure

- `apps/brain/src/proactive/clock.ts`: the trip's local hour and day, "8 am tomorrow" as an instant, `Schedule` and `realSchedule`.
- `apps/brain/src/proactive/policy.ts`: the bar, the budget, the quietest useful action, batching; pure.
- `apps/brain/src/proactive/policy.test.ts`: policy and clock tests.
- `apps/brain/src/db/migrations/5000_proactive.sql`: `proactive_candidates`, `proactive_trips`, `proactive_notices`.
- `apps/brain/src/proactive/store.ts`: candidates, the trip's signals (posts today, hushes, ignored nudges), saved notices.
- `apps/brain/src/proactive/fakes.ts`: test fakes (the Goa trip, packs, a recording server link, a desk, a hand-moved clock, a fake `Brain`).
- `apps/brain/src/proactive/store.test.ts`: store tests.
- `apps/brain/src/proactive/timers.ts`: timer planning, re-planning, date clashes, the "still true" check.
- `apps/brain/src/proactive/timers.test.ts`: timer tests.
- `apps/brain/src/proactive/payload.ts`: what a proactive desk item carries.
- `apps/brain/src/proactive/promoter.ts`: due candidates through the policy onto the desk.
- `apps/brain/src/proactive/promoter.test.ts`: promoter tests.
- `apps/brain/src/proactive/words.ts`: `plain()`, `clip()`, `quote()`, `rupees()`, `namesOf()`.
- `apps/brain/src/proactive/allowed.ts`: the tools a proactive turn may use.
- `apps/brain/src/proactive/wake.ts`: wake renderers for `timer`, `watch`, `opening`; the `openings` "right now" block.
- `apps/brain/src/proactive/notice-tools.ts`: quick tools `post_notice` and `update_notice`.
- `apps/brain/src/proactive/wake.test.ts`, `apps/brain/src/proactive/notice-tools.test.ts`: tests.
- `apps/brain/src/proactive/openings.ts`: openings from the chat and from trip changes, hush, ignored nudges.
- `apps/brain/src/proactive/openings.test.ts`: tests.
- `apps/brain/src/db/migrations/5100_watches.sql`: `watches`.
- `apps/brain/src/watches/port.ts`: the normalised status reading and the adapter over `Travel.status`.
- `apps/brain/src/watches/diff.ts`: which change in a reading is worth a nudge.
- `apps/brain/src/watches/plan.ts`: which watches a trip needs; syncing them.
- `apps/brain/src/watches/watches.test.ts`: port, diff and plan tests.
- `apps/brain/src/watches/runner.ts`: scheduled checks.
- `apps/brain/src/watches/admin.ts`: `POST /admin/watch/fire`.
- `apps/brain/src/proactive/register.ts`: `startProactive(brain)` and `registerProactive(brain)`; also wires watches.
- `apps/brain/src/watches/runner.test.ts`, `apps/brain/src/proactive/register.test.ts`: tests, including the 3:40 demo beat.
- `apps/brain/src/db/migrations/5200_calls.sql`: `calls`.
- `apps/brain/src/calls/config.ts`: settings, allowlist, phone numbers, URLs, fixed numbers.
- `apps/brain/src/calls/stop-words.ts`: "stop" in English and Hinglish.
- `apps/brain/src/calls/store.ts`: the call row and its state changes.
- `apps/brain/src/calls/foundation.test.ts`: config, stop words and store tests.
- `apps/brain/src/calls/twilio.ts`: Twilio REST client, TwiML, signature check, status words.
- `apps/brain/src/calls/twilio.test.ts`: tests.
- `apps/brain/src/calls/realtime.ts`: the call's instructions, the session, `report_outcome`.
- `apps/brain/src/calls/bridge.ts`: Twilio media socket to the realtime model and back.
- `apps/brain/src/calls/bridge.test.ts`: tests with a scripted local realtime server.
- `apps/brain/src/calls/card-updater.ts`: one card update every 3 s at most, the final one always.
- `apps/brain/src/calls/service.ts`: `CallService`: request, stop window, dial, live card, outcome, failures, sweep.
- `apps/brain/src/calls/tool.ts`: the `call_business` quick tool.
- `apps/brain/src/calls/card-updater.test.ts`, `apps/brain/src/calls/service.test.ts`: tests.
- `apps/brain/src/calls/register.ts`: `startCalls(brain)`, `registerCalls(brain)`: routes, media socket, tap, hooks, the `calls` "right now" block.
- `apps/brain/src/calls/register.test.ts`: the whole call end to end.
- `apps/brain/src/main.ts` (modify): call `registerProactive` and `registerCalls`.
- `apps/brain/scripts/calls-day-one.mjs`: the day-one check for Twilio, India dialing and the realtime model.

---

### Task 1: The bar (policy and the trip's clock)

**Files:**
- Create: `apps/brain/src/proactive/clock.ts`
- Create: `apps/brain/src/proactive/policy.ts`
- Test: `apps/brain/src/proactive/policy.test.ts`

**Interfaces:**
- Consumes: nothing outside this task.
- Produces:
  - `clock.ts`: `DEFAULT_TZ = 'Asia/Kolkata'`; `type Schedule = (fn: () => void, ms: number) => () => void`; `realSchedule: Schedule`; `localHour(at: Date, tz: string): number`; `localDay(at: Date, tz: string): string` (YYYY-MM-DD); `offsetMinutes(at: Date, tz: string): number`; `zonedTime(day: string, hour: number, minute: number, tz: string): Date`; `addDays(day: string, n: number): string`; `isNight(at: Date, tz: string): boolean`; `nextMorning(at: Date, tz: string): Date`; `tomorrowMorning(at: Date, tz: string): Date`; `localWhen(at: Date, tz: string): string`; `isValidTz(tz: string): boolean`.
  - `policy.ts`: `ACTIONS = ['react','record','update_card','pin','message'] as const`; `type Action`; `type Source = 'timer' | 'watch' | 'opening'`; `isPost(a: Action): boolean`; `interface Candidate { tripId; dedupeKey; source: Source; topic: string; dueAt: Date; expiresAt: Date | null; importance; confidence; urgency: number; useful: Action[]; personIds: string[]; facts: Record<string, unknown>; simulated: boolean; small: boolean }`; `interface TripMood { tz; postsToday; lastProactivePostAt: Date | null; lastPersonMessageAt: Date | null; hushCount; lastHushAt: Date | null; ignoredCount; pausedPersonIds: string[] }`; `BARS`, `NIGHT_RAISE`, `HUSH_RAISE`, `HUSH_CAP`, `HUSH_LASTS_MS`, `IGNORED_RAISE`, `IGNORED_CAP`, `DAILY_POSTS`, `SMALL_HOLD_MS`, `RECHECK_MS`; `score(c): number`; `barRaise(m, now): { night: number; mood: number }`; `lastWordIsGos(m): boolean`; `type Decision`; `decide(c, m, now): Decision`; `decideBatch(cands, m, now): Array<{ candidate: Candidate; decision: Decision }>`.

The rules, in plain words. Each candidate says which actions would be useful (`useful`). The quiet actions (a reaction, a record line, updating a notice Go posted earlier) are allowed when the score clears their bar. Of the two posts, only the quietest one that applies is ever allowed: a pin when the nudge concerns particular people who have not paused Go, otherwise a message to everyone. Posts also need budget left today and a person to have spoken since Go's last unprompted post. Bars rise by 0.25 at night, by 0.15 per hush (for 72 hours, at most 0.45) and by 0.05 per ignored nudge (at most 0.2). Bars rise with loudness, so if the quietest useful action fails its bar, every louder one fails too.

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/proactive/policy.test.ts
import { describe, expect, it } from 'vitest';
import { addDays, isNight, localDay, localHour, nextMorning, tomorrowMorning, zonedTime } from './clock.js';
import {
  BARS,
  DAILY_POSTS,
  RECHECK_MS,
  SMALL_HOLD_MS,
  barRaise,
  decide,
  decideBatch,
  score,
  type Candidate,
  type TripMood,
} from './policy.js';

const TZ = 'Asia/Kolkata';
const NOON = new Date('2026-10-06T06:30:00Z'); // 12:00 in Goa
const LATE = new Date('2026-10-06T17:00:00Z'); // 22:30 in Goa

const mood = (over: Partial<TripMood> = {}): TripMood => ({
  tz: TZ,
  postsToday: 0,
  lastProactivePostAt: null,
  lastPersonMessageAt: new Date('2026-10-06T06:00:00Z'),
  hushCount: 0,
  lastHushAt: null,
  ignoredCount: 0,
  pausedPersonIds: [],
  ...over,
});

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  tripId: 't_goa',
  dedupeKey: 'k1',
  source: 'watch',
  topic: 'flight_status',
  dueAt: NOON,
  expiresAt: null,
  importance: 0.9,
  confidence: 1,
  urgency: 0.9,
  useful: ['pin', 'message'],
  personIds: ['p_arjun'],
  facts: {},
  simulated: false,
  small: false,
  ...over,
});

const chat = (over: Partial<Candidate> = {}): Candidate =>
  cand({ source: 'opening', topic: 'chat', importance: 0.6, confidence: 0.9, urgency: 0.9, useful: ['react', 'record', 'message'], personIds: [], ...over });

describe('the trip clock', () => {
  it('reads the hour and the day in the trip time zone', () => {
    expect(localHour(NOON, TZ)).toBe(12);
    expect(localHour(LATE, TZ)).toBe(22);
    expect(localDay(new Date('2026-10-06T19:00:00Z'), TZ)).toBe('2026-10-07');
  });

  it('knows night is 22:00 to 08:00 local', () => {
    expect(isNight(NOON, TZ)).toBe(false);
    expect(isNight(LATE, TZ)).toBe(true);
    expect(isNight(new Date('2026-10-07T02:00:00Z'), TZ)).toBe(true); // 07:30
    expect(isNight(new Date('2026-10-07T02:30:00Z'), TZ)).toBe(false); // 08:00
  });

  it('turns a local wall time into an instant, across daylight saving too', () => {
    expect(zonedTime('2026-11-05', 19, 0, TZ).toISOString()).toBe('2026-11-05T13:30:00.000Z');
    expect(zonedTime('2026-07-01', 8, 0, 'Europe/London').toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(zonedTime('2026-12-01', 8, 0, 'Europe/London').toISOString()).toBe('2026-12-01T08:00:00.000Z');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-06', -1)).toBe('2026-11-05');
  });

  it('finds the next 8 am', () => {
    expect(nextMorning(LATE, TZ).toISOString()).toBe('2026-10-07T02:30:00.000Z');
    expect(nextMorning(new Date('2026-10-06T20:00:00Z'), TZ).toISOString()).toBe('2026-10-07T02:30:00.000Z'); // 01:30 local
    expect(tomorrowMorning(NOON, TZ).toISOString()).toBe('2026-10-07T02:30:00.000Z');
  });
});

describe('score and bars', () => {
  it('multiplies importance, confidence and urgency, clamped to 0..1', () => {
    expect(score({ importance: 0.5, confidence: 0.5, urgency: 0.5 })).toBeCloseTo(0.125);
    expect(score({ importance: 2, confidence: 1, urgency: -1 })).toBe(0);
  });

  it('raises the bar at night, after a hush and after ignored nudges', () => {
    expect(barRaise(mood(), NOON)).toEqual({ night: 0, mood: 0 });
    expect(barRaise(mood(), LATE).night).toBeCloseTo(0.25);
    expect(barRaise(mood({ hushCount: 1, lastHushAt: NOON }), NOON).mood).toBeCloseTo(0.15);
    expect(barRaise(mood({ hushCount: 9, lastHushAt: NOON }), NOON).mood).toBeCloseTo(0.45);
    const old = new Date(NOON.getTime() - 73 * 3600_000);
    expect(barRaise(mood({ hushCount: 2, lastHushAt: old }), NOON).mood).toBe(0);
    expect(barRaise(mood({ ignoredCount: 9 }), NOON).mood).toBeCloseTo(0.2);
  });

  it('orders bars from quietest to loudest', () => {
    expect(BARS.react).toBeLessThan(BARS.record);
    expect(BARS.record).toBeLessThan(BARS.update_card);
    expect(BARS.update_card).toBeLessThan(BARS.pin);
    expect(BARS.pin).toBeLessThan(BARS.message);
  });
});

describe('decide', () => {
  it('pins a flight delay to Arjun only, never a message to everyone', () => {
    const d = decide(cand(), mood(), NOON);
    expect(d).toMatchObject({ kind: 'go', allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true });
  });

  it('still pins a big delay at night', () => {
    expect(decide(cand(), mood(), LATE)).toMatchObject({ kind: 'go', allowed: ['pin'] });
  });

  it('falls back to a message when nobody in particular is concerned', () => {
    const d = decide(cand({ personIds: [] }), mood(), NOON);
    expect(d).toMatchObject({ kind: 'go', allowed: ['message'], forPersonIds: [], counted: true });
  });

  it('offers a chat opening every quiet action plus one message by day', () => {
    expect(decide(chat(), mood(), NOON)).toMatchObject({ kind: 'go', allowed: ['react', 'record', 'message'], counted: true });
  });

  it('keeps a chat opening to quiet actions at night', () => {
    expect(decide(chat(), mood(), LATE)).toMatchObject({ kind: 'go', allowed: ['react', 'record'], counted: false });
  });

  it('holds a message that would pass by day until 8 am', () => {
    const c = cand({ topic: 'vote_closed', source: 'opening', importance: 0.8, urgency: 0.8, useful: ['message'], personIds: [] });
    expect(decide(c, mood(), LATE)).toEqual({ kind: 'wait', until: new Date('2026-10-07T02:30:00.000Z'), reason: 'night' });
  });

  it('drops a night nudge that expires before morning', () => {
    const c = cand({ importance: 0.8, urgency: 0.8, useful: ['message'], personIds: [], expiresAt: new Date(LATE.getTime() + 3600_000) });
    expect(decide(c, mood(), LATE)).toEqual({ kind: 'drop', reason: 'below_bar' });
  });

  it('drops what is below even the day bar', () => {
    expect(decide(cand({ importance: 0.2 }), mood(), NOON)).toEqual({ kind: 'drop', reason: 'below_bar' });
  });

  it('stops posting once the day budget is spent and waits for tomorrow', () => {
    const d = decide(cand({ useful: ['pin'] }), mood({ postsToday: DAILY_POSTS }), NOON);
    expect(d).toEqual({ kind: 'wait', until: new Date('2026-10-07T02:30:00.000Z'), reason: 'budget' });
  });

  it('still allows quiet actions when the budget is spent', () => {
    expect(decide(chat(), mood({ postsToday: DAILY_POSTS }), NOON)).toMatchObject({ kind: 'go', allowed: ['react', 'record'], counted: false });
  });

  it('never posts twice in a row without a person speaking', () => {
    const m = mood({ lastProactivePostAt: new Date('2026-10-06T06:10:00Z'), lastPersonMessageAt: new Date('2026-10-06T06:00:00Z') });
    expect(decide(cand({ useful: ['pin'] }), m, NOON)).toEqual({ kind: 'wait', until: new Date(NOON.getTime() + RECHECK_MS), reason: 'two_in_a_row' });
    const spoke = mood({ lastProactivePostAt: new Date('2026-10-06T06:10:00Z'), lastPersonMessageAt: new Date('2026-10-06T06:20:00Z') });
    expect(decide(cand({ useful: ['pin'] }), spoke, NOON)).toMatchObject({ kind: 'go', allowed: ['pin'] });
  });

  it('lets a hush lower how chatty Go is', () => {
    const hushed = mood({ hushCount: 1, lastHushAt: NOON });
    expect(decide(chat(), hushed, NOON)).toMatchObject({ kind: 'go', allowed: ['react', 'record'], counted: false });
  });

  it('never pings someone who paused Go', () => {
    expect(decide(cand(), mood({ pausedPersonIds: ['p_arjun'] }), NOON)).toEqual({ kind: 'drop', reason: 'paused' });
    const two = decide(cand({ personIds: ['p_arjun', 'p_meher'] }), mood({ pausedPersonIds: ['p_arjun'] }), NOON);
    expect(two).toMatchObject({ kind: 'go', forPersonIds: ['p_meher'] });
  });

  it('drops what has expired', () => {
    expect(decide(cand({ expiresAt: NOON }), mood(), NOON)).toEqual({ kind: 'drop', reason: 'expired' });
  });

  it('drops a pin-only nudge with nobody to pin', () => {
    expect(decide(cand({ useful: ['pin'], personIds: [] }), mood(), NOON)).toEqual({ kind: 'drop', reason: 'nothing_useful' });
  });

  it('lets the simulated demo watch through like any other', () => {
    const sim = cand({ simulated: true, dedupeKey: 'sim:flight_status:ab12cd34', expiresAt: new Date(NOON.getTime() + 2 * 3600_000) });
    expect(decide(sim, mood(), NOON)).toMatchObject({ kind: 'go', allowed: ['pin'], forPersonIds: ['p_arjun'] });
  });
});

describe('decideBatch', () => {
  const small = cand({ dedupeKey: 'fare:1', topic: 'fare', useful: ['message'], personIds: [], importance: 0.5, confidence: 1, urgency: 1, small: true });

  it('holds a small post alone for up to 6 hours', () => {
    const [only] = decideBatch([small], mood(), NOON);
    expect(only?.decision).toEqual({ kind: 'wait', until: new Date(NOON.getTime() + SMALL_HOLD_MS), reason: 'small' });
  });

  it('lets a small post ride along with a bigger one', () => {
    const out = decideBatch([small, cand()], mood(), NOON);
    expect(out.map((o) => o.decision.kind)).toEqual(['go', 'go']);
  });

  it('lets a small post go once it has waited long enough', () => {
    const later = new Date(NOON.getTime() + SMALL_HOLD_MS);
    const [only] = decideBatch([small], mood(), later);
    expect(only?.decision.kind).toBe('go');
  });

  it('lets a small post go now when it would expire before the hold ends', () => {
    const soon = { ...small, expiresAt: new Date(NOON.getTime() + 3600_000) };
    const [only] = decideBatch([soon], mood(), NOON);
    expect(only?.decision.kind).toBe('go');
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the modules do not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/brain/src/proactive/clock.ts
// Time in the trip's own time zone: the local hour and day, and "8 am tomorrow" as a real instant.
export const DEFAULT_TZ = 'Asia/Kolkata';
export const NIGHT_FROM_HOUR = 22;
export const NIGHT_UNTIL_HOUR = 8;

/** Runs `fn` after `ms`; returns a cancel. Injected everywhere so tests move time by hand. */
export type Schedule = (fn: () => void, ms: number) => () => void;
export const realSchedule: Schedule = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formats.set(tz, f);
  }
  return f;
}

interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number }
function parts(at: Date, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of format(tz).formatToParts(at)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { year: out.year ?? 1970, month: out.month ?? 1, day: out.day ?? 1, hour: out.hour ?? 0, minute: out.minute ?? 0, second: out.second ?? 0 };
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localHour(at: Date, tz: string): number {
  return parts(at, tz).hour;
}

export function localDay(at: Date, tz: string): string {
  const p = parts(at, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes the zone is ahead of UTC at that instant (330 for India). */
export function offsetMinutes(at: Date, tz: string): number {
  const p = parts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant when the clock on the wall in `tz` shows `hour:minute` on `day` (YYYY-MM-DD). */
export function zonedTime(day: string, hour: number, minute: number, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  let t = wall - offsetMinutes(new Date(wall), tz) * 60_000;
  t = wall - offsetMinutes(new Date(t), tz) * 60_000;
  return new Date(t);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function isNight(at: Date, tz: string): boolean {
  const h = localHour(at, tz);
  return h >= NIGHT_FROM_HOUR || h < NIGHT_UNTIL_HOUR;
}

/** 8 am local: today's if it is still before 8, else tomorrow's. */
export function nextMorning(at: Date, tz: string): Date {
  const day = localDay(at, tz);
  return zonedTime(localHour(at, tz) < NIGHT_UNTIL_HOUR ? day : addDays(day, 1), NIGHT_UNTIL_HOUR, 0, tz);
}

/** 8 am local tomorrow: a spent daily budget is fresh again and it is not night. */
export function tomorrowMorning(at: Date, tz: string): Date {
  return zonedTime(addDays(localDay(at, tz), 1), NIGHT_UNTIL_HOUR, 0, tz);
}

/** "Fri, 6 Nov, 8:45 pm" in the trip's zone, for Go's own words. */
export function localWhen(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}
```

```ts
// apps/brain/src/proactive/policy.ts
// The proactive bar: whether Go may act without being asked, and the quietest action that does the job.
// Pure functions. The numbers are starting points that replays tune.
import { isNight, nextMorning, tomorrowMorning } from './clock.js';

/** Quietest first. */
export const ACTIONS = ['react', 'record', 'update_card', 'pin', 'message'] as const;
export type Action = (typeof ACTIONS)[number];
export type Source = 'timer' | 'watch' | 'opening';

const POSTS: ReadonlySet<Action> = new Set<Action>(['pin', 'message']);
/** A pin and a message both put a new message in the room; they spend the daily budget. */
export const isPost = (a: Action): boolean => POSTS.has(a);

/** Something Go noticed on its own. `dedupeKey` is unique per trip: the same nudge is never made twice. */
export interface Candidate {
  tripId: string;
  dedupeKey: string;
  source: Source;
  topic: string;
  dueAt: Date;
  expiresAt: Date | null;
  importance: number;
  confidence: number;
  urgency: number;
  useful: Action[];
  personIds: string[];
  facts: Record<string, unknown>;
  simulated: boolean;
  small: boolean;
}

/** What the bar knows about the trip right now. */
export interface TripMood {
  tz: string;
  postsToday: number;
  lastProactivePostAt: Date | null;
  lastPersonMessageAt: Date | null;
  hushCount: number;
  lastHushAt: Date | null;
  ignoredCount: number;
  pausedPersonIds: string[];
}

export const BARS: Readonly<Record<Action, number>> = { react: 0.1, record: 0.15, update_card: 0.2, pin: 0.3, message: 0.45 };
export const NIGHT_RAISE = 0.25;
export const HUSH_RAISE = 0.15;
export const HUSH_CAP = 0.45;
export const HUSH_LASTS_MS = 72 * 3600_000;
export const IGNORED_RAISE = 0.05;
export const IGNORED_CAP = 0.2;
export const DAILY_POSTS = 3;
export const SMALL_HOLD_MS = 6 * 3600_000;
export const RECHECK_MS = 5 * 60_000;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export function score(c: Pick<Candidate, 'importance' | 'confidence' | 'urgency'>): number {
  return clamp01(c.importance) * clamp01(c.confidence) * clamp01(c.urgency);
}

/** How far above the day bars Go's bars sit for this trip right now. */
export function barRaise(m: TripMood, now: Date): { night: number; mood: number } {
  const night = isNight(now, m.tz) ? NIGHT_RAISE : 0;
  const hushFresh = m.lastHushAt !== null && now.getTime() - m.lastHushAt.getTime() < HUSH_LASTS_MS;
  const hush = hushFresh ? Math.min(HUSH_CAP, HUSH_RAISE * m.hushCount) : 0;
  const ignored = Math.min(IGNORED_CAP, IGNORED_RAISE * m.ignoredCount);
  return { night, mood: hush + ignored };
}

/** True when Go's last unprompted post has had no person speak after it. */
export function lastWordIsGos(m: TripMood): boolean {
  if (m.lastProactivePostAt === null) return false;
  return m.lastPersonMessageAt === null || m.lastPersonMessageAt.getTime() <= m.lastProactivePostAt.getTime();
}

export type Decision =
  | { kind: 'go'; allowed: Action[]; forPersonIds: string[]; counted: boolean; score: number; bar: number }
  | { kind: 'wait'; until: Date; reason: 'night' | 'budget' | 'two_in_a_row' | 'small' }
  | { kind: 'drop'; reason: 'expired' | 'paused' | 'below_bar' | 'budget' | 'two_in_a_row' | 'nothing_useful' };

const beforeExpiry = (until: Date, expiresAt: Date | null): boolean => expiresAt === null || until.getTime() < expiresAt.getTime();

export function decide(c: Candidate, m: TripMood, now: Date): Decision {
  if (c.expiresAt !== null && now.getTime() >= c.expiresAt.getTime()) return { kind: 'drop', reason: 'expired' };
  const paused = new Set(m.pausedPersonIds);
  const targets = c.personIds.filter((p) => !paused.has(p));
  if (c.personIds.length > 0 && targets.length === 0) return { kind: 'drop', reason: 'paused' };

  const s = score(c);
  const raise = barRaise(m, now);
  const quiet: Action[] = [];
  let post: Action | null = null;
  let blocked: 'night' | 'below_bar' | 'budget' | 'two_in_a_row' | null = null;
  let bar = 0;
  for (const a of ACTIONS) {
    if (!c.useful.includes(a)) continue;
    if (a === 'pin' && targets.length === 0) continue;
    const need = BARS[a] + raise.night + raise.mood;
    if (s < need) {
      // Bars rise with loudness, so nothing louder can pass either.
      blocked = raise.night > 0 && s >= BARS[a] + raise.mood ? 'night' : 'below_bar';
      break;
    }
    if (!isPost(a)) {
      quiet.push(a);
      bar = need;
      continue;
    }
    if (m.postsToday >= DAILY_POSTS) {
      blocked = 'budget';
      break;
    }
    if (lastWordIsGos(m)) {
      blocked = 'two_in_a_row';
      break;
    }
    post = a;
    bar = need;
    break; // the quietest post that applies; a louder one is never allowed alongside it
  }

  if (post !== null || quiet.length > 0) {
    return {
      kind: 'go',
      allowed: post !== null ? [...quiet, post] : quiet,
      forPersonIds: post === 'pin' ? targets : [],
      counted: post !== null,
      score: s,
      bar,
    };
  }
  if (blocked === 'night') {
    const until = nextMorning(now, m.tz);
    return beforeExpiry(until, c.expiresAt) ? { kind: 'wait', until, reason: 'night' } : { kind: 'drop', reason: 'below_bar' };
  }
  if (blocked === 'budget') {
    const until = tomorrowMorning(now, m.tz);
    return beforeExpiry(until, c.expiresAt) ? { kind: 'wait', until, reason: 'budget' } : { kind: 'drop', reason: 'budget' };
  }
  if (blocked === 'two_in_a_row') {
    const until = new Date(now.getTime() + RECHECK_MS);
    return beforeExpiry(until, c.expiresAt) ? { kind: 'wait', until, reason: 'two_in_a_row' } : { kind: 'drop', reason: 'two_in_a_row' };
  }
  return { kind: 'drop', reason: blocked === 'below_bar' ? 'below_bar' : 'nothing_useful' };
}

/**
 * Decides every due candidate of one trip together. They land in one turn, so they share one post of the
 * budget. A small post waits (up to SMALL_HOLD_MS) for a bigger one to ride along with.
 */
export function decideBatch(cands: Candidate[], m: TripMood, now: Date): Array<{ candidate: Candidate; decision: Decision }> {
  const out = cands.map((candidate) => ({ candidate, decision: decide(candidate, m, now) }));
  const bigPost = out.some((o) => o.decision.kind === 'go' && o.decision.counted && !o.candidate.small);
  return out.map((o) => {
    const d = o.decision;
    if (d.kind !== 'go' || !d.counted || !o.candidate.small || bigPost) return o;
    const heldUntil = new Date(o.candidate.dueAt.getTime() + SMALL_HOLD_MS);
    if (now.getTime() >= heldUntil.getTime()) return o;
    if (o.candidate.expiresAt !== null && o.candidate.expiresAt.getTime() <= heldUntil.getTime()) return o;
    return { candidate: o.candidate, decision: { kind: 'wait' as const, until: heldUntil, reason: 'small' as const } };
  });
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/proactive/clock.ts apps/brain/src/proactive/policy.ts apps/brain/src/proactive/policy.test.ts
git commit -m "feat(proactive): the bar, the budget and the quietest useful action, in the trip's own time zone

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `policy.test.ts` passes (clock, score, bars, decide, decideBatch).

### Task 2: The candidate store and the shared test fakes

**Files:**
- Create: `apps/brain/src/db/migrations/5000_proactive.sql`
- Create: `apps/brain/src/proactive/store.ts`
- Create: `apps/brain/src/proactive/fakes.ts`
- Test: `apps/brain/src/proactive/store.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `Action`, `Source`, `ACTIONS` (Task 1); `DEFAULT_TZ`, `isValidTz` (Task 1); `withSchema()` (P1); `Brain` (P1 `app.ts`); `DeskItem` (P1); `QuickTool`, `TurnCtx` (P1); `NowProvider` (P1); `ServerLink` (P1); `TripPack` (P1); `Message`, `Trip`, `TripEvent`, `CardTapParams`, `CardTapResult` (P1 `door/methods.ts`); `ReflexRead` (P1 stub / P2); `TripSnapshot`, `Message`, `Card`, `NoticeCard` from `@go/contract`.
- Produces:
  - `store.ts`: `type NoticeIn = z.input<typeof NoticeCard>`; `interface Signals { postsToday; lastProactivePostAt: Date | null; hushCount; lastHushAt: Date | null; ignoredCount }`; `interface SavedNotice { tripId; cardId; messageId; card: NoticeIn }`; `interface ToCheck { tripId; dedupeKey; decidedAt: Date; postedMessageId: string | null }`; `class ProactiveStore` with `add(c): Promise<'added' | 'exists'>`, `plan(c): Promise<void>`, `dropUnplanned(tripId, keep: string[], now): Promise<number>`, `due(now, limit?): Promise<Candidate[]>`, `promote(c, d: { allowed: Action[]; forPersonIds: string[]; counted: boolean; localDay: string }, now): Promise<void>`, `defer(c, until, reason): Promise<void>`, `drop(c, reason, now): Promise<void>`, `status(tripId, key): Promise<{ status: string; reason: string | null; allowed: Action[] | null; counted: boolean; dueAt: Date; postedMessageId: string | null } | null>`, `signals(tripId, localDay): Promise<Signals>`, `tripTz(tripId): Promise<string>`, `tripExists(tripId): Promise<boolean>`, `hush(tripId, now)`, `ignored(tripId, now)`, `resetBudget(tripId, localDay): Promise<number>`, `posted(tripId, key, messageId)`, `toCheckForIgnored(before, limit?): Promise<ToCheck[]>`, `ignoreChecked(tripId, key, now)`, `saveNotice(n: SavedNotice)`, `notice(tripId, cardId): Promise<SavedNotice | null>`.
  - `fakes.ts` (tests only): `GOA_TZ`, `goaTrip(over?)`, `msg(o)`, `goaPack(o?)`, `fakePacks(...packs)`, `fakeLink(o?)`, `fakeDesk()`, `manualTime(startIso)`, `waitFor(check, ms?)`, `candidate(over?)`, `unsureRead(over?)`, `turnCtx(o)`, `seedTrip(pool, tripId, tz?)`, `fakeBrain(o)` returning `{ brain, app, reg, link, desk, packs, switches }`.

A candidate's primary key is `(trip_id, dedupe_key)`. `add` never revives a key it has seen, whatever happened to it; that is "never repeat a nudge" by construction. `plan` (timers only) may move a pending timer to a new time, and may revive a timer only if it was dropped by re-planning (the dates moved away and came back).

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/proactive/store.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import { candidate, seedTrip } from './fakes.js';
import { ProactiveStore } from './store.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let store: ProactiveStore;
const NOON = new Date('2026-10-06T06:30:00Z');

beforeAll(async () => {
  db = await withSchema();
  store = new ProactiveStore(db.pool);
  await seedTrip(db.pool, 't_goa', 'Asia/Kolkata');
});
afterAll(async () => {
  await db.drop();
});

describe('ProactiveStore', () => {
  it('never adds the same nudge twice, even after it was dropped', async () => {
    const c = candidate({ dedupeKey: 'once:1' });
    expect(await store.add(c)).toBe('added');
    expect(await store.add(c)).toBe('exists');
    await store.drop(c, 'below_bar', NOON);
    expect(await store.add(c)).toBe('exists');
    expect((await store.status('t_goa', 'once:1'))?.status).toBe('dropped');
  });

  it('returns only pending candidates that are due', async () => {
    const due = candidate({ dedupeKey: 'due:1', dueAt: new Date(NOON.getTime() - 1000) });
    const later = candidate({ dedupeKey: 'due:2', dueAt: new Date(NOON.getTime() + 60_000) });
    await store.add(due);
    await store.add(later);
    const keys = (await store.due(NOON)).map((c) => c.dedupeKey);
    expect(keys).toContain('due:1');
    expect(keys).not.toContain('due:2');
    const got = (await store.due(NOON)).find((c) => c.dedupeKey === 'due:1');
    expect(got).toMatchObject({ tripId: 't_goa', source: 'watch', useful: ['pin', 'message'], personIds: ['p_arjun'], importance: 0.9 });
  });

  it('moves a pending timer, leaves a decided one alone, and revives one dropped by re-planning', async () => {
    const t = candidate({ dedupeKey: 'timer:1', source: 'timer', topic: 'travel_day', dueAt: NOON });
    await store.plan(t);
    await store.plan({ ...t, dueAt: new Date(NOON.getTime() + 3600_000) });
    expect((await store.status('t_goa', 'timer:1'))?.dueAt.toISOString()).toBe('2026-10-06T07:30:00.000Z');

    expect(await store.dropUnplanned('t_goa', [], NOON)).toBeGreaterThanOrEqual(1);
    expect((await store.status('t_goa', 'timer:1'))?.reason).toBe('replanned');
    await store.plan(t);
    expect((await store.status('t_goa', 'timer:1'))?.status).toBe('pending');

    await store.promote(t, { allowed: ['message'], forPersonIds: [], counted: true, localDay: '2026-10-06' }, NOON);
    await store.plan({ ...t, dueAt: new Date(NOON.getTime() + 7200_000) });
    expect((await store.status('t_goa', 'timer:1'))?.status).toBe('promoted');
  });

  it('defers a candidate to a later time with a reason', async () => {
    const c = candidate({ dedupeKey: 'defer:1', dueAt: NOON });
    await store.add(c);
    await store.defer(c, new Date('2026-10-07T02:30:00Z'), 'night');
    const s = await store.status('t_goa', 'defer:1');
    expect(s).toMatchObject({ status: 'pending', reason: 'night' });
    expect(s?.dueAt.toISOString()).toBe('2026-10-07T02:30:00.000Z');
  });

  it('counts posts per local day by batch, and a reset clears them', async () => {
    await seedTrip(db.pool, 't_budget', 'Asia/Kolkata');
    const a = candidate({ tripId: 't_budget', dedupeKey: 'b:1' });
    const b = candidate({ tripId: 't_budget', dedupeKey: 'b:2' });
    const c = candidate({ tripId: 't_budget', dedupeKey: 'b:3' });
    for (const x of [a, b, c]) await store.add(x);
    const day = '2026-10-06';
    await store.promote(a, { allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true, localDay: day }, NOON);
    await store.promote(b, { allowed: ['message'], forPersonIds: [], counted: true, localDay: day }, NOON); // same batch
    const later = new Date(NOON.getTime() + 3600_000);
    await store.promote(c, { allowed: ['react'], forPersonIds: [], counted: false, localDay: day }, later);
    const sig = await store.signals('t_budget', day);
    expect(sig.postsToday).toBe(1);
    expect(sig.lastProactivePostAt?.toISOString()).toBe(NOON.toISOString());
    expect(await store.resetBudget('t_budget', day)).toBe(2);
    expect((await store.signals('t_budget', day)).postsToday).toBe(0);
  });

  it('keeps hushes and ignored nudges per trip', async () => {
    await store.hush('t_goa', NOON);
    await store.hush('t_goa', NOON);
    await store.ignored('t_goa', NOON);
    const sig = await store.signals('t_goa', '2026-10-06');
    expect(sig).toMatchObject({ hushCount: 2, ignoredCount: 1 });
    expect(sig.lastHushAt?.toISOString()).toBe(NOON.toISOString());
  });

  it('reads the trip time zone, with India as the fallback', async () => {
    await seedTrip(db.pool, 't_london', 'Europe/London');
    expect(await store.tripTz('t_london')).toBe('Europe/London');
    expect(await store.tripTz('t_nowhere')).toBe('Asia/Kolkata');
    expect(await store.tripExists('t_goa')).toBe(true);
    expect(await store.tripExists('t_nowhere')).toBe(false);
  });

  it('remembers what Go posted and which nudges still need the ignored check', async () => {
    const c = candidate({ dedupeKey: 'ign:1' });
    await store.add(c);
    await store.promote(c, { allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true, localDay: '2026-10-06' }, NOON);
    await store.posted('t_goa', 'ign:1', 'm_go_1');
    const rows = await store.toCheckForIgnored(new Date(NOON.getTime() + 1000));
    expect(rows).toContainEqual({ tripId: 't_goa', dedupeKey: 'ign:1', decidedAt: NOON, postedMessageId: 'm_go_1' });
    await store.ignoreChecked('t_goa', 'ign:1', NOON);
    expect((await store.toCheckForIgnored(new Date(NOON.getTime() + 1000))).map((r) => r.dedupeKey)).not.toContain('ign:1');
  });

  it('saves and reads back a notice card', async () => {
    const card = { card_id: 'c_notice_1', kind: 'notice' as const, fallback_text: 'Heads up', tone: 'heads_up' as const, title: 'Heads up', body: 'Your flight is late.' };
    await store.saveNotice({ tripId: 't_goa', cardId: 'c_notice_1', messageId: 'm_go_9', card });
    expect(await store.notice('t_goa', 'c_notice_1')).toEqual({ tripId: 't_goa', cardId: 'c_notice_1', messageId: 'm_go_9', card });
    expect(await store.notice('t_goa', 'c_missing')).toBeNull();
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the modules do not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```sql
-- apps/brain/src/db/migrations/5000_proactive.sql
-- What Go noticed on its own, held until the bar lets it act, and how chatty Go has been per trip.
create table proactive_candidates (
  trip_id text not null,
  dedupe_key text not null,
  source text not null check (source in ('timer', 'watch', 'opening')),
  topic text not null,
  due_at timestamptz not null,
  expires_at timestamptz,
  importance double precision not null check (importance between 0 and 1),
  confidence double precision not null check (confidence between 0 and 1),
  urgency double precision not null check (urgency between 0 and 1),
  useful text[] not null,
  person_ids text[] not null default '{}',
  facts jsonb not null default '{}',
  simulated boolean not null default false,
  small boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'promoted', 'dropped')),
  reason text,
  allowed text[],
  for_person_ids text[],
  counted boolean not null default false,
  decided_at timestamptz,
  local_day text,
  posted_message_id text,
  ignore_checked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (trip_id, dedupe_key)
);
create index proactive_candidates_due on proactive_candidates (due_at) where status = 'pending';
create index proactive_candidates_counted on proactive_candidates (trip_id, local_day) where counted;

create table proactive_trips (
  trip_id text primary key,
  hush_count integer not null default 0,
  last_hush_at timestamptz,
  ignored_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create table proactive_notices (
  trip_id text not null,
  card_id text not null,
  message_id text not null,
  card jsonb not null,
  created_at timestamptz not null default now(),
  primary key (trip_id, card_id)
);
```

```ts
// apps/brain/src/proactive/store.ts
// What Go noticed on its own, held until the bar says it may act, and the per-trip signals the bar
// reads: unprompted posts today, hushes, nudges people ignored. Also the notice cards Go posted.
import type { NoticeCard } from '@go/contract';
import type pg from 'pg';
import type { z } from 'zod';
import { DEFAULT_TZ, isValidTz } from './clock.js';
import { ACTIONS, type Action, type Candidate, type Source } from './policy.js';

export type NoticeIn = z.input<typeof NoticeCard>;

export interface Signals {
  postsToday: number;
  lastProactivePostAt: Date | null;
  hushCount: number;
  lastHushAt: Date | null;
  ignoredCount: number;
}
export interface SavedNotice { tripId: string; cardId: string; messageId: string; card: NoticeIn }
export interface ToCheck { tripId: string; dedupeKey: string; decidedAt: Date; postedMessageId: string | null }

type CandidateRow = {
  trip_id: string;
  dedupe_key: string;
  source: Source;
  topic: string;
  due_at: Date;
  expires_at: Date | null;
  importance: number;
  confidence: number;
  urgency: number;
  useful: string[];
  person_ids: string[];
  facts: Record<string, unknown>;
  simulated: boolean;
  small: boolean;
};

const isAction = (a: string): a is Action => (ACTIONS as readonly string[]).includes(a);

function toCandidate(r: CandidateRow): Candidate {
  return {
    tripId: r.trip_id,
    dedupeKey: r.dedupe_key,
    source: r.source,
    topic: r.topic,
    dueAt: r.due_at,
    expiresAt: r.expires_at,
    importance: r.importance,
    confidence: r.confidence,
    urgency: r.urgency,
    useful: r.useful.filter(isAction),
    personIds: r.person_ids,
    facts: r.facts,
    simulated: r.simulated,
    small: r.small,
  };
}

const COLS = 'trip_id, dedupe_key, source, topic, due_at, expires_at, importance, confidence, urgency, useful, person_ids, facts, simulated, small';
const PLACES = '$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14';
const values = (c: Candidate): unknown[] => [
  c.tripId, c.dedupeKey, c.source, c.topic, c.dueAt, c.expiresAt, c.importance, c.confidence, c.urgency,
  c.useful, c.personIds, JSON.stringify(c.facts), c.simulated, c.small,
];

export class ProactiveStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Adds something Go noticed. A key seen before is never added again: Go never repeats a nudge. */
  async add(c: Candidate): Promise<'added' | 'exists'> {
    const r = await this.pool.query(
      `insert into proactive_candidates (${COLS}) values (${PLACES}) on conflict (trip_id, dedupe_key) do nothing`,
      values(c),
    );
    return r.rowCount === 1 ? 'added' : 'exists';
  }

  /** Timers: plans one, or moves a pending one to its new time. A decided one stays decided. */
  async plan(c: Candidate): Promise<void> {
    await this.pool.query(
      `insert into proactive_candidates (${COLS}) values (${PLACES})
       on conflict (trip_id, dedupe_key) do update set
         due_at = excluded.due_at, expires_at = excluded.expires_at, person_ids = excluded.person_ids,
         facts = excluded.facts, useful = excluded.useful, status = 'pending', reason = null, decided_at = null
       where proactive_candidates.status = 'pending'
          or (proactive_candidates.status = 'dropped' and proactive_candidates.reason = 'replanned')`,
      values(c),
    );
  }

  /** Timers no longer planned (the vote closed early, the dates moved) stop waiting. */
  async dropUnplanned(tripId: string, keep: string[], now: Date): Promise<number> {
    const r = await this.pool.query(
      `update proactive_candidates set status = 'dropped', reason = 'replanned', decided_at = $3
       where trip_id = $1 and source = 'timer' and status = 'pending' and not (dedupe_key = any($2::text[]))`,
      [tripId, keep, now],
    );
    return r.rowCount ?? 0;
  }

  async due(now: Date, limit = 50): Promise<Candidate[]> {
    const r = await this.pool.query<CandidateRow>(
      `select ${COLS} from proactive_candidates where status = 'pending' and due_at <= $1 order by trip_id, due_at limit $2`,
      [now, limit],
    );
    return r.rows.map(toCandidate);
  }

  async promote(c: Candidate, d: { allowed: Action[]; forPersonIds: string[]; counted: boolean; localDay: string }, now: Date): Promise<void> {
    await this.pool.query(
      `update proactive_candidates set status = 'promoted', reason = null, allowed = $3, for_person_ids = $4,
         counted = $5, decided_at = $6, local_day = $7, person_ids = $8
       where trip_id = $1 and dedupe_key = $2 and status = 'pending'`,
      [c.tripId, c.dedupeKey, d.allowed, d.forPersonIds, d.counted, now, d.localDay, c.personIds],
    );
  }

  async defer(c: Candidate, until: Date, reason: string): Promise<void> {
    await this.pool.query(
      `update proactive_candidates set due_at = $3, reason = $4 where trip_id = $1 and dedupe_key = $2 and status = 'pending'`,
      [c.tripId, c.dedupeKey, until, reason],
    );
  }

  async drop(c: Candidate, reason: string, now: Date): Promise<void> {
    await this.pool.query(
      `update proactive_candidates set status = 'dropped', reason = $3, decided_at = $4
       where trip_id = $1 and dedupe_key = $2 and status = 'pending'`,
      [c.tripId, c.dedupeKey, reason, now],
    );
  }

  async status(tripId: string, key: string): Promise<{ status: string; reason: string | null; allowed: Action[] | null; counted: boolean; dueAt: Date; postedMessageId: string | null } | null> {
    const r = await this.pool.query<{ status: string; reason: string | null; allowed: string[] | null; counted: boolean; due_at: Date; posted_message_id: string | null }>(
      `select status, reason, allowed, counted, due_at, posted_message_id from proactive_candidates where trip_id = $1 and dedupe_key = $2`,
      [tripId, key],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      status: row.status,
      reason: row.reason,
      allowed: row.allowed ? row.allowed.filter(isAction) : null,
      counted: row.counted,
      dueAt: row.due_at,
      postedMessageId: row.posted_message_id,
    };
  }

  /** Posts are counted per batch (one promotion instant), so things batched into one turn spend one post. */
  async signals(tripId: string, localDay: string): Promise<Signals> {
    const posts = await this.pool.query<{ n: number; last: Date | null }>(
      `select (select count(distinct decided_at)::int from proactive_candidates
                where trip_id = $1 and status = 'promoted' and counted and local_day = $2) as n,
              (select max(decided_at) from proactive_candidates
                where trip_id = $1 and status = 'promoted' and counted) as last`,
      [tripId, localDay],
    );
    const t = await this.pool.query<{ hush_count: number; last_hush_at: Date | null; ignored_count: number }>(
      `select hush_count, last_hush_at, ignored_count from proactive_trips where trip_id = $1`,
      [tripId],
    );
    const p = posts.rows[0];
    const s = t.rows[0];
    return {
      postsToday: p?.n ?? 0,
      lastProactivePostAt: p?.last ?? null,
      hushCount: s?.hush_count ?? 0,
      lastHushAt: s?.last_hush_at ?? null,
      ignoredCount: s?.ignored_count ?? 0,
    };
  }

  async tripTz(tripId: string): Promise<string> {
    const r = await this.pool.query<{ tz: string | null }>(`select tz from trips where trip_id = $1`, [tripId]);
    const tz = r.rows[0]?.tz;
    return tz && isValidTz(tz) ? tz : DEFAULT_TZ;
  }

  async tripExists(tripId: string): Promise<boolean> {
    const r = await this.pool.query(`select 1 from trips where trip_id = $1`, [tripId]);
    return (r.rowCount ?? 0) > 0;
  }

  async hush(tripId: string, now: Date): Promise<void> {
    await this.pool.query(
      `insert into proactive_trips (trip_id, hush_count, last_hush_at, updated_at) values ($1, 1, $2, $2)
       on conflict (trip_id) do update set hush_count = proactive_trips.hush_count + 1, last_hush_at = $2, updated_at = $2`,
      [tripId, now],
    );
  }

  async ignored(tripId: string, now: Date): Promise<void> {
    await this.pool.query(
      `insert into proactive_trips (trip_id, ignored_count, updated_at) values ($1, 1, $2)
       on conflict (trip_id) do update set ignored_count = proactive_trips.ignored_count + 1, updated_at = $2`,
      [tripId, now],
    );
  }

  /** Admin only (rehearsals): today's posts stop counting against the budget. */
  async resetBudget(tripId: string, localDay: string): Promise<number> {
    const r = await this.pool.query(
      `update proactive_candidates set counted = false where trip_id = $1 and local_day = $2 and counted`,
      [tripId, localDay],
    );
    return r.rowCount ?? 0;
  }

  async posted(tripId: string, key: string, messageId: string): Promise<void> {
    await this.pool.query(
      `update proactive_candidates set posted_message_id = coalesce(posted_message_id, $3) where trip_id = $1 and dedupe_key = $2`,
      [tripId, key, messageId],
    );
  }

  async toCheckForIgnored(before: Date, limit = 100): Promise<ToCheck[]> {
    const r = await this.pool.query<{ trip_id: string; dedupe_key: string; decided_at: Date; posted_message_id: string | null }>(
      `select trip_id, dedupe_key, decided_at, posted_message_id from proactive_candidates
       where status = 'promoted' and counted and ignore_checked_at is null and decided_at < $1
       order by decided_at limit $2`,
      [before, limit],
    );
    return r.rows.map((x) => ({ tripId: x.trip_id, dedupeKey: x.dedupe_key, decidedAt: x.decided_at, postedMessageId: x.posted_message_id }));
  }

  async ignoreChecked(tripId: string, key: string, now: Date): Promise<void> {
    await this.pool.query(`update proactive_candidates set ignore_checked_at = $3 where trip_id = $1 and dedupe_key = $2`, [tripId, key, now]);
  }

  async saveNotice(n: SavedNotice): Promise<void> {
    await this.pool.query(
      `insert into proactive_notices (trip_id, card_id, message_id, card) values ($1, $2, $3, $4)
       on conflict (trip_id, card_id) do update set card = excluded.card`,
      [n.tripId, n.cardId, n.messageId, JSON.stringify(n.card)],
    );
  }

  async notice(tripId: string, cardId: string): Promise<SavedNotice | null> {
    const r = await this.pool.query<{ message_id: string; card: NoticeIn }>(
      `select message_id, card from proactive_notices where trip_id = $1 and card_id = $2`,
      [tripId, cardId],
    );
    const row = r.rows[0];
    return row ? { tripId, cardId, messageId: row.message_id, card: row.card } : null;
  }
}
```

```ts
// apps/brain/src/proactive/fakes.ts
// Test fakes shared by the proactive, watches and calls tests: the Goa trip from the guide, a pack, a
// server link that records every request, a desk that keeps what it is given, a clock whose timers move by
// hand, and a fake Brain that records what a lane registers. Nothing here runs in production.
import { Message as MessageSchema, TripSnapshot, type Card } from '@go/contract';
import Fastify from 'fastify';
import type pg from 'pg';
import type { Brain } from '../app.js';
import type { NowProvider } from '../composer/context.js';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
import type { DeskItem } from '../desk/desk.js';
import type { CardTapParams, CardTapResult, Message, Trip, TripEvent } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { ReflexRead } from '../reflex/reflex.js';
import type { TripPack } from '../trips/pack.js';
import type { Candidate } from './policy.js';

export const GOA_TZ = 'Asia/Kolkata';
const EVERYONE = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];

const person = (person_id: string, name: string, role: 'organizer' | 'member' = 'member') => ({
  person_id, name, role, joined_at: '2026-10-05T02:30:00Z', know: [], has_upi: false, go_paused: false,
});

/** The guide's Goa trip, trimmed: one open vote (Arjun and Meher have not voted), the villa and a flight. */
export function goaTrip(over: Partial<Trip> = {}): Trip {
  return TripSnapshot.parse({
    trip_id: 't_goa',
    seq: 120,
    title: 'Goa',
    status: 'planning',
    created_at: '2026-10-05T02:30:00Z',
    organizer_person_id: 'p_rahul',
    invite_url: 'https://go.example/j/8fK2xQ',
    dates: { start: '2026-11-06', end: '2026-11-09' },
    vibe: ['beaches'],
    budget: { answered: 0, of: 5 },
    people: [person('p_rahul', 'Rahul', 'organizer'), person('p_priya', 'Priya'), person('p_arjun', 'Arjun'), person('p_meher', 'Meher'), person('p_kabir', 'Kabir')],
    decisions: [
      {
        decision_id: 'd_villa',
        question: 'Where do we stay?',
        kind: 'choice',
        anonymous: false,
        status: 'open',
        options: [
          { label: 'Villa Sol', price_minor: 5420000, currency: 'INR', option_ref: 'ixigo:stay:villa-sol-anjuna' },
          { label: 'Casa Azul', price_minor: 6180000, currency: 'INR', option_ref: 'ixigo:stay:casa-azul-assagao' },
        ],
        closes_at: '2026-10-06T12:30:00Z',
        voted: 3,
        of: 5,
        tally: [2, 1],
        votes: [
          { person_id: 'p_rahul', option_index: 0 },
          { person_id: 'p_priya', option_index: 0 },
          { person_id: 'p_kabir', option_index: 1 },
        ],
        opened_at: '2026-10-05T07:30:00Z',
      },
    ],
    bookings: [
      {
        booking_id: 'b_villa', kind: 'stay', status: 'confirmed', title: 'Villa Sol, 3 nights', vendor: 'ixigo', ref: 'IXG-7Q2K9',
        amount_minor: 5420000, currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: EVERYONE,
        refundable_until: '2026-11-01T18:29:59Z', starts_at: '2026-11-06T14:00:00+05:30', ends_at: '2026-11-09T11:00:00+05:30',
        created_at: '2026-10-05T09:03:00Z',
      },
      {
        booking_id: 'b_flight', kind: 'flight', status: 'confirmed', title: 'IndiGo 6E 2134, Delhi to Goa', vendor: 'ixigo', ref: 'PNR6E2134',
        amount_minor: 1650000, currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: ['p_rahul', 'p_priya', 'p_kabir'],
        starts_at: '2026-11-06T18:15:00+05:30', ends_at: '2026-11-06T20:45:00+05:30',
        journey: {
          mode: 'flight', origin: { name: 'Delhi', code: 'DEL' }, destination: { name: 'Goa', code: 'GOX' },
          depart_at: '2026-11-06T18:15:00+05:30', arrive_at: '2026-11-06T20:45:00+05:30',
          carrier_name: 'IndiGo', carrier_code: '6E', number: '2134',
        },
        created_at: '2026-10-05T10:00:00Z',
      },
    ],
    expenses: [],
    money: { currency: 'INR', spent_minor: 7070000, by_category: [], transfers: [] },
    itinerary: [],
    record: [],
    ...over,
  });
}

let nextSeq = 200;
export function msg(o: {
  id?: string;
  seq?: number;
  by?: string;
  text?: string | null;
  mentionsGo?: boolean;
  replyTo?: string;
  sentAt?: string;
  reactions?: Array<{ emoji: string; person_id?: string }>;
  withheld?: boolean;
  deleted?: boolean;
}): Message {
  nextSeq += 1;
  const seq = o.seq ?? nextSeq;
  const go = o.by === 'go';
  return MessageSchema.parse({
    message_id: o.id ?? `m_${seq}`,
    seq,
    updated_seq: seq,
    author: go ? { kind: 'go' } : { kind: 'person', person_id: o.by ?? 'p_priya' },
    text: o.text === undefined ? 'hi' : o.text,
    attachments: [],
    ...(o.replyTo ? { reply_to: o.replyTo } : {}),
    mentions_go: go ? false : (o.mentionsGo ?? false),
    mentions: [],
    reactions: o.reactions ?? [],
    withheld: o.withheld ?? false,
    deleted: o.deleted ?? false,
    sent_at: o.sentAt ?? '2026-10-06T06:00:00Z',
  });
}

export function goaPack(o: { trip?: Trip; messages?: Message[] } = {}): TripPack {
  const trip = o.trip ?? goaTrip();
  return { trip, messages: o.messages ?? [], seq: trip.seq };
}

export function fakePacks(...packs: TripPack[]) {
  const byId = new Map(packs.map((p) => [p.trip.trip_id, p]));
  return {
    set(p: TripPack): void {
      byId.set(p.trip.trip_id, p);
    },
    async get(tripId: string): Promise<TripPack> {
      const p = byId.get(tripId);
      if (!p) throw new Error(`no pack for ${tripId}`);
      return p;
    },
    invalidate(_tripId: string): void {},
  };
}

export interface LinkCall { method: string; params: Record<string, unknown> }

/** A ServerLink that records every request and answers like the Server would. */
export function fakeLink(o: { trip?: Trip; fail?: (method: string) => Error | null } = {}) {
  const calls: LinkCall[] = [];
  let n = 0;
  const answer = (method: string, params: Record<string, unknown>): unknown => {
    n += 1;
    switch (method) {
      case 'post_message':
        return { message_id: `m_go_${n}`, seq: 1000 + n };
      case 'replace_card':
        return { message_id: `m_card_${String((params.card as { card_id?: string } | undefined)?.card_id)}` };
      case 'add_record_line':
        return { line_id: `r_${n}`, seq: 1000 + n };
      case 'read_trip':
        return o.trip ?? goaTrip();
      default:
        return { seq: 1000 + n };
    }
  };
  const link = {
    calls,
    of(method: string): Array<Record<string, unknown>> {
      return calls.filter((c) => c.method === method).map((c) => c.params);
    },
    async request(method: string, params: Record<string, unknown>): Promise<unknown> {
      calls.push({ method, params });
      const err = o.fail?.(method) ?? null;
      if (err) throw err;
      return answer(method, params);
    },
    notify(method: string, params: Record<string, unknown>): void {
      calls.push({ method, params });
    },
    isOpen: (): boolean => true,
  };
  return link as typeof link & ServerLink;
}

export function fakeDesk() {
  const items: DeskItem[] = [];
  const cancelled: Array<{ tripId: string; ref: string }> = [];
  return {
    items,
    cancelled,
    async put(item: Omit<DeskItem, 'id'> & { id?: string }): Promise<void> {
      const id = item.id ?? `desk_${items.length + 1}`;
      if (items.some((i) => i.id === id)) return;
      items.push({ ...item, id });
    },
    async cancel(tripId: string, ref: string): Promise<void> {
      cancelled.push({ tripId, ref });
    },
  };
}

/** A clock whose timers run only when the test moves time forward. */
export function manualTime(startIso: string) {
  let t = Date.parse(startIso);
  let order = 0;
  const timers: Array<{ at: number; n: number; fn: () => void }> = [];
  return {
    now: (): Date => new Date(t),
    schedule(fn: () => void, ms: number): () => void {
      const timer = { at: t + ms, n: order++, fn };
      timers.push(timer);
      return () => {
        const i = timers.indexOf(timer);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    /** Moves the clock forward, running every timer that falls due, in order. */
    advance(ms: number): void {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.n - b.n);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
    pending: (): number => timers.length,
  };
}

export async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    tripId: 't_goa',
    dedupeKey: 'test:1',
    source: 'watch',
    topic: 'flight_status',
    dueAt: new Date('2026-10-06T06:30:00Z'),
    expiresAt: null,
    importance: 0.9,
    confidence: 1,
    urgency: 0.9,
    useful: ['pin', 'message'],
    personIds: ['p_arjun'],
    facts: {},
    simulated: false,
    small: false,
    ...over,
  };
}

export function unsureRead(over: Partial<ReflexRead> = {}): ReflexRead {
  const u = { value: null, sure: false } as const;
  return { forGo: u, complete: u, size: u, taskId: u, fact: u, recordKind: u, reaction: u, risky: u, opening: u, ...over };
}

export function turnCtx(o: { link: ServerLink; pack: TripPack; wake: DeskItem[] }): TurnCtx {
  return {
    tripId: o.pack.trip.trip_id,
    turnId: 'turn_test',
    link: o.link,
    pack: o.pack,
    outcome: { spoke: false, silent: false, reactions: 0, posts: [] as string[] },
    wake: o.wake,
  } as TurnCtx;
}

export async function seedTrip(pool: pg.Pool, tripId: string, tz = GOA_TZ): Promise<void> {
  await pool.query(`insert into trips (trip_id, last_seq, tz) values ($1, 0, $2) on conflict (trip_id) do nothing`, [tripId, tz]);
}

type ReadHook = (msg: Message, read: ReflexRead, pack: TripPack) => Promise<void>;
type EventHook = (ev: TripEvent) => void | Promise<void>;
type TapHook = (tap: CardTapParams, card: Card) => Promise<CardTapResult>;

export interface Registered {
  tools: Array<QuickTool<any>>;
  wakes: Map<string, (item: DeskItem, pack: TripPack) => string>;
  nows: NowProvider[];
  onRead: ReadHook[];
  onEvent: EventHook[];
  taps: Map<string, TapHook>;
}

/** A Brain whose parts record what a lane registers. `http` is a real Fastify instance (not listening). */
export function fakeBrain(o: { pool: pg.Pool; now: () => Date; env?: Record<string, string>; switches?: Record<string, string>; pack?: TripPack }) {
  const app = Fastify();
  const reg: Registered = { tools: [], wakes: new Map(), nows: [], onRead: [], onEvent: [], taps: new Map() };
  const link = fakeLink();
  const desk = fakeDesk();
  const packs = fakePacks(o.pack ?? goaPack());
  const values: Record<string, string> = { ...(o.switches ?? {}) };
  const switches = {
    values,
    get: (name: string): string => values[name] ?? '',
    set: async (name: string, value: string): Promise<void> => {
      values[name] = value;
    },
  };
  const brain = {
    env: { ...(o.env ?? {}) },
    pool: o.pool,
    log: app.log,
    now: o.now,
    http: app,
    door: { link, handle: (): void => {} },
    taps: { on: (kind: string, action: string, h: TapHook): void => { reg.taps.set(`${kind}:${action}`, h); } },
    tripLog: {
      onEvent: (fn: EventHook): void => { reg.onEvent.push(fn); },
      append: async (): Promise<'new'> => 'new',
      lastSeq: async (): Promise<number> => 0,
    },
    packs,
    setup: { addStep: (): void => {}, ensureTrip: async (): Promise<void> => {} },
    desk,
    tools: { register: (t: QuickTool<any>): void => { reg.tools.push(t); }, list: (): Array<QuickTool<any>> => reg.tools },
    context: {
      addNow: (p: NowProvider): void => { reg.nows.push(p); },
      addWake: (kind: string, render: (item: DeskItem, pack: TripPack) => string): void => { reg.wakes.set(kind, render); },
    },
    hooks: { onRead: (fn: ReadHook): void => { reg.onRead.push(fn); } },
    switches,
    reflex: { read: async (): Promise<ReflexRead> => unsureRead() },
  } as unknown as Brain;
  return { brain, app, reg, link, desk, packs, switches };
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/db/migrations/5000_proactive.sql apps/brain/src/proactive/store.ts apps/brain/src/proactive/fakes.ts apps/brain/src/proactive/store.test.ts
git commit -m "feat(proactive): a store where every nudge is kept once, with the trip's budget, hushes and notices

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `store.test.ts` passes against the CI Postgres; earlier tests stay green.

### Task 3: Timers (planned from the trip, re-planned on every change, checked again when due)

**Files:**
- Create: `apps/brain/src/proactive/timers.ts`
- Test: `apps/brain/src/proactive/timers.test.ts`

**Interfaces:**
- Consumes: `Candidate` (Task 1); `addDays`, `zonedTime` (Task 1); `ProactiveStore.plan`, `ProactiveStore.dropUnplanned` (Task 2); `Trip` (P1 `door/methods.ts`); `TripPack` (P1).
- Produces: `VOTE_REMINDER_BEFORE_MS`, `FREE_CANCEL_BEFORE_MS`, `PAYER_WAIT_MS`, `TRAVEL_DAY_HOUR = 19`, `SETTLE_UP_HOUR = 11`; `nonVoters(trip: Trip, decisionId: string): string[]`; `dateClashes(trip: Trip): Array<{ booking_id: string; title: string; starts_at: string; ends_at: string | null }>`; `planTimers(trip: Trip, tz: string, now: Date): Candidate[]`; `replanTimers(store: ProactiveStore, trip: Trip, tz: string, now: Date): Promise<number>`; `type Check = { ok: true; personIds: string[] } | { ok: false }`; `stillTrue(c: Candidate, pack: TripPack): Check`.

Decision: timers are candidates in `proactive_candidates` with a future `due_at`, not desk items with a future due time. The desk has no gate before a turn, so a timer put straight on the desk would always cost a model turn and could not be held for the morning or for the budget. The promoter (Task 4) puts the desk item, with a stable id (`pro:<trip>:<dedupe key>`), only when the bar passes. Each timer's dedupe key carries the moment it is about (`vote_closing:d_villa:<closes_at>`), so moving a vote's closing time plans a new reminder and drops the old one.

The five timers, from spec §8 "Time":

| Topic | Due | Pinned to | Useful |
|---|---|---|---|
| `vote_closing` | 2 h before `closes_at` (now if less is left), while people have not voted | people who have not voted (none for an anonymous vote) | pin (message for anonymous votes) |
| `free_cancel` | 24 h before a confirmed booking's `refundable_until` | the payer | pin |
| `travel_day` | 19:00 local the evening before `dates.start` | nobody | message |
| `settle_up` | 11:00 local the day after `dates.end`, only if settle-up still has transfers | nobody | message |
| `payer_waiting` | 24 h after `mandate.set_at` while the payer has neither confirmed nor declined | the payer | pin |

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/proactive/timers.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import { goaPack, goaTrip, msg, seedTrip } from './fakes.js';
import { ProactiveStore } from './store.js';
import { dateClashes, nonVoters, planTimers, replanTimers, stillTrue } from './timers.js';

const TZ = 'Asia/Kolkata';
const NOON = new Date('2026-10-06T06:30:00Z');
const byTopic = (cs: ReturnType<typeof planTimers>, topic: string) => cs.filter((c) => c.topic === topic);

describe('planTimers', () => {
  const plans = planTimers(goaTrip(), TZ, NOON);

  it('reminds the people who have not voted 2 hours before the vote closes', () => {
    const [v] = byTopic(plans, 'vote_closing');
    expect(v).toMatchObject({
      dedupeKey: 'vote_closing:d_villa:2026-10-06T12:30:00Z',
      source: 'timer',
      useful: ['pin'],
      personIds: ['p_arjun', 'p_meher'],
    });
    expect(v?.dueAt.toISOString()).toBe('2026-10-06T10:30:00.000Z');
    expect(v?.expiresAt?.toISOString()).toBe('2026-10-06T12:30:00.000Z');
  });

  it('warns the payer a day before free cancellation ends', () => {
    const [f] = byTopic(plans, 'free_cancel');
    expect(f).toMatchObject({ personIds: ['p_rahul'], useful: ['pin'] });
    expect(f?.dueAt.toISOString()).toBe('2026-10-31T18:29:59.000Z');
  });

  it('plans travel day at 7 pm local the evening before, and settle-up the day after', () => {
    expect(byTopic(plans, 'travel_day')[0]?.dueAt.toISOString()).toBe('2026-11-05T13:30:00.000Z');
    expect(byTopic(plans, 'settle_up')[0]?.dueAt.toISOString()).toBe('2026-11-10T05:30:00.000Z');
  });

  it('plans nothing for a payer until a mandate waits', () => {
    expect(byTopic(plans, 'payer_waiting')).toHaveLength(0);
    const base = goaTrip();
    const d = { ...base.decisions[0]!, status: 'closed' as const, mandate: { choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul', set_at: '2026-10-05T05:00:00Z' } };
    const [p] = byTopic(planTimers(goaTrip({ decisions: [d] }), TZ, NOON), 'payer_waiting');
    expect(p).toMatchObject({ personIds: ['p_rahul'], dedupeKey: 'payer_waiting:d_villa:2026-10-05T05:00:00Z' });
    expect(p?.dueAt.toISOString()).toBe(NOON.toISOString()); // already a day: due now
  });

  it('is due now when less than 2 hours are left, and uses a message for an anonymous vote', () => {
    const base = goaTrip();
    const d = { ...base.decisions[0]!, anonymous: true, votes: null, closes_at: '2026-10-06T07:30:00Z' };
    const [v] = byTopic(planTimers(goaTrip({ decisions: [d] }), TZ, NOON), 'vote_closing');
    expect(v).toMatchObject({ useful: ['message'], personIds: [] });
    expect(v?.dueAt.toISOString()).toBe(NOON.toISOString());
  });

  it('plans nothing that has already passed', () => {
    const after = new Date('2026-11-20T00:00:00Z');
    expect(planTimers(goaTrip(), TZ, after)).toEqual([]);
  });
});

describe('the trip helpers', () => {
  it('lists the people who have not voted', () => {
    expect(nonVoters(goaTrip(), 'd_villa')).toEqual(['p_arjun', 'p_meher']);
    expect(nonVoters(goaTrip(), 'd_missing')).toEqual([]);
  });

  it('finds bookings that fall outside new dates', () => {
    expect(dateClashes(goaTrip())).toEqual([]);
    const moved = goaTrip({ dates: { start: '2026-11-13', end: '2026-11-16' } });
    expect(dateClashes(moved).map((c) => c.booking_id)).toEqual(['b_villa', 'b_flight']);
  });
});

describe('stillTrue', () => {
  const plans = planTimers(goaTrip(), TZ, NOON);
  const vote = byTopic(plans, 'vote_closing')[0]!;

  it('refreshes who still has not voted', () => {
    const base = goaTrip();
    const d = { ...base.decisions[0]!, voted: 4, votes: [...(base.decisions[0]!.votes ?? []), { person_id: 'p_arjun', option_index: 0 }] };
    expect(stillTrue(vote, goaPack({ trip: goaTrip({ decisions: [d] }) }))).toEqual({ ok: true, personIds: ['p_meher'] });
  });

  it('drops a vote reminder once the vote closed or moved', () => {
    const base = goaTrip();
    expect(stillTrue(vote, goaPack({ trip: goaTrip({ decisions: [{ ...base.decisions[0]!, status: 'closed' }] }) }))).toEqual({ ok: false });
    expect(stillTrue(vote, goaPack({ trip: goaTrip({ decisions: [{ ...base.decisions[0]!, closes_at: '2026-10-07T12:30:00Z' }] }) }))).toEqual({ ok: false });
  });

  it('needs open transfers for settle-up', () => {
    const settle = byTopic(plans, 'settle_up')[0]!;
    expect(stillTrue(settle, goaPack())).toEqual({ ok: false });
    const owed = goaTrip({ money: { currency: 'INR', spent_minor: 1, by_category: [], transfers: [{ from_person_id: 'p_priya', to_person_id: 'p_rahul', amount_minor: 100, currency: 'INR' }] } });
    expect(stillTrue(settle, goaPack({ trip: owed }))).toMatchObject({ ok: true });
  });

  it('drops a chat opening whose message was deleted', () => {
    const c = { ...vote, topic: 'chat', source: 'opening' as const, facts: { message_id: 'm_7', seq: 7 } };
    expect(stillTrue(c, goaPack({ messages: [msg({ id: 'm_7', seq: 7 })] }))).toMatchObject({ ok: true });
    expect(stillTrue(c, goaPack({ messages: [msg({ id: 'm_7', seq: 7, deleted: true, text: null })] }))).toEqual({ ok: false });
  });
});

describe('replanTimers', () => {
  let db: Awaited<ReturnType<typeof withSchema>>;
  let store: ProactiveStore;
  beforeAll(async () => {
    db = await withSchema();
    store = new ProactiveStore(db.pool);
    await seedTrip(db.pool, 't_goa');
  });
  afterAll(async () => {
    await db.drop();
  });

  it('is safe to repeat, and moves a reminder when the vote closing time moves', async () => {
    expect(await replanTimers(store, goaTrip(), TZ, NOON)).toBe(4);
    await replanTimers(store, goaTrip(), TZ, NOON);
    const pending = await db.pool.query(`select dedupe_key from proactive_candidates where trip_id = 't_goa' and status = 'pending' order by dedupe_key`);
    expect(pending.rows).toHaveLength(4);

    const base = goaTrip();
    const later = goaTrip({ decisions: [{ ...base.decisions[0]!, closes_at: '2026-10-07T12:30:00Z' }] });
    await replanTimers(store, later, TZ, NOON);
    expect((await store.status('t_goa', 'vote_closing:d_villa:2026-10-06T12:30:00Z'))?.reason).toBe('replanned');
    expect((await store.status('t_goa', 'vote_closing:d_villa:2026-10-07T12:30:00Z'))?.status).toBe('pending');
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the module does not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/brain/src/proactive/timers.ts
// Timers: moments worth a nudge that the clock alone brings (a vote about to close, free cancellation
// ending, travel day, settle-up, a payer who has not answered). Planned from the trip as it is now,
// re-planned on every trip change, and checked again against the trip when they come due.
import type { Trip } from '../door/methods.js';
import type { TripPack } from '../trips/pack.js';
import { addDays, zonedTime } from './clock.js';
import type { Action, Candidate } from './policy.js';
import type { ProactiveStore } from './store.js';

const H = 3600_000;
export const VOTE_REMINDER_BEFORE_MS = 2 * H;
export const FREE_CANCEL_BEFORE_MS = 24 * H;
export const PAYER_WAIT_MS = 24 * H;
export const TRAVEL_DAY_HOUR = 19;
export const SETTLE_UP_HOUR = 11;

export function nonVoters(trip: Trip, decisionId: string): string[] {
  const d = trip.decisions.find((x) => x.decision_id === decisionId);
  if (!d || d.anonymous) return [];
  const voted = new Set((d.votes ?? []).map((v) => v.person_id));
  return trip.people.filter((p) => !voted.has(p.person_id)).map((p) => p.person_id);
}

/** Confirmed bookings that fall outside the trip's dates (a day of slack each side for time zones). */
export function dateClashes(trip: Trip): Array<{ booking_id: string; title: string; starts_at: string; ends_at: string | null }> {
  const dates = trip.dates;
  if (!dates) return [];
  const out: Array<{ booking_id: string; title: string; starts_at: string; ends_at: string | null }> = [];
  for (const b of trip.bookings) {
    if (b.status !== 'confirmed' || !b.starts_at) continue;
    const startDay = b.starts_at.slice(0, 10);
    const endDay = (b.ends_at ?? b.starts_at).slice(0, 10);
    if (startDay < addDays(dates.start, -1) || endDay > addDays(dates.end, 1)) {
      out.push({ booking_id: b.booking_id, title: b.title, starts_at: b.starts_at, ends_at: b.ends_at ?? null });
    }
  }
  return out;
}

export function planTimers(trip: Trip, tz: string, now: Date): Candidate[] {
  const t = now.getTime();
  const notBefore = (at: number): Date => new Date(Math.max(at, t));
  const inTrip = new Set(trip.people.map((p) => p.person_id));
  const out: Candidate[] = [];
  const timer = (o: {
    key: string;
    topic: string;
    dueAt: Date;
    expiresAt: Date | null;
    importance: number;
    urgency: number;
    useful: Action[];
    personIds: string[];
    facts: Record<string, unknown>;
  }): Candidate => ({
    tripId: trip.trip_id,
    dedupeKey: o.key,
    source: 'timer',
    topic: o.topic,
    dueAt: o.dueAt,
    expiresAt: o.expiresAt,
    importance: o.importance,
    confidence: 1,
    urgency: o.urgency,
    useful: o.useful,
    personIds: o.personIds,
    facts: o.facts,
    simulated: false,
    small: false,
  });

  for (const d of trip.decisions) {
    if (d.status === 'open' && d.closes_at && d.voted < d.of) {
      const closes = Date.parse(d.closes_at);
      if (closes > t) {
        out.push(timer({
          key: `vote_closing:${d.decision_id}:${d.closes_at}`,
          topic: 'vote_closing',
          dueAt: notBefore(closes - VOTE_REMINDER_BEFORE_MS),
          expiresAt: new Date(closes),
          importance: 0.6,
          urgency: 0.8,
          useful: d.anonymous ? ['message'] : ['pin'],
          personIds: d.anonymous ? [] : nonVoters(trip, d.decision_id),
          facts: { decision_id: d.decision_id, closes_at: d.closes_at },
        }));
      }
    }
    const m = d.mandate;
    if (m && m.confirmed_at == null && m.declined_at == null && inTrip.has(m.payer_person_id)) {
      const due = Date.parse(m.set_at) + PAYER_WAIT_MS;
      const expires = due + 48 * H;
      if (expires > t) {
        out.push(timer({
          key: `payer_waiting:${d.decision_id}:${m.set_at}`,
          topic: 'payer_waiting',
          dueAt: notBefore(due),
          expiresAt: new Date(expires),
          importance: 0.6,
          urgency: 0.7,
          useful: ['pin'],
          personIds: [m.payer_person_id],
          facts: { decision_id: d.decision_id, set_at: m.set_at },
        }));
      }
    }
  }

  for (const b of trip.bookings) {
    if (b.status !== 'confirmed' || !b.refundable_until) continue;
    const until = Date.parse(b.refundable_until);
    if (until <= t) continue;
    out.push(timer({
      key: `free_cancel:${b.booking_id}:${b.refundable_until}`,
      topic: 'free_cancel',
      dueAt: notBefore(until - FREE_CANCEL_BEFORE_MS),
      expiresAt: new Date(until),
      importance: 0.7,
      urgency: 0.7,
      useful: ['pin'],
      personIds: inTrip.has(b.payer_person_id) ? [b.payer_person_id] : [],
      facts: { booking_id: b.booking_id, refundable_until: b.refundable_until },
    }));
  }

  if (trip.dates && trip.status !== 'over') {
    const due = zonedTime(addDays(trip.dates.start, -1), TRAVEL_DAY_HOUR, 0, tz);
    const expires = due.getTime() + 5 * H;
    if (expires > t) {
      out.push(timer({
        key: `travel_day:${trip.dates.start}`,
        topic: 'travel_day',
        dueAt: notBefore(due.getTime()),
        expiresAt: new Date(expires),
        importance: 0.6,
        urgency: 0.8,
        useful: ['message'],
        personIds: [],
        facts: { start: trip.dates.start },
      }));
    }
  }

  if (trip.dates) {
    const due = zonedTime(addDays(trip.dates.end, 1), SETTLE_UP_HOUR, 0, tz);
    const expires = due.getTime() + 72 * H;
    if (expires > t) {
      out.push(timer({
        key: `settle_up:${trip.dates.end}`,
        topic: 'settle_up',
        dueAt: notBefore(due.getTime()),
        expiresAt: new Date(expires),
        importance: 0.6,
        urgency: 0.8,
        useful: ['message'],
        personIds: [],
        facts: { end: trip.dates.end },
      }));
    }
  }
  return out;
}

/** Level-triggered: whatever the trip looks like now decides which timers wait. Safe to repeat. */
export async function replanTimers(store: ProactiveStore, trip: Trip, tz: string, now: Date): Promise<number> {
  const plans = planTimers(trip, tz, now);
  for (const c of plans) await store.plan(c);
  await store.dropUnplanned(trip.trip_id, plans.map((c) => c.dedupeKey), now);
  return plans.length;
}

export type Check = { ok: true; personIds: string[] } | { ok: false };

/** Checked when a candidate comes due: is what Go noticed still true? Also refreshes who it concerns. */
export function stillTrue(c: Candidate, pack: TripPack): Check {
  const trip = pack.trip;
  const f = c.facts;
  const yes = (personIds: string[] = c.personIds): Check => ({ ok: true, personIds });
  const no: Check = { ok: false };
  switch (c.topic) {
    case 'vote_closing': {
      const d = trip.decisions.find((x) => x.decision_id === f.decision_id);
      if (!d || d.status !== 'open' || d.closes_at !== f.closes_at || d.voted >= d.of) return no;
      return yes(d.anonymous ? [] : nonVoters(trip, d.decision_id));
    }
    case 'payer_waiting': {
      const m = trip.decisions.find((x) => x.decision_id === f.decision_id)?.mandate;
      if (!m || m.set_at !== f.set_at || m.confirmed_at != null || m.declined_at != null) return no;
      return yes();
    }
    case 'free_cancel': {
      const b = trip.bookings.find((x) => x.booking_id === f.booking_id);
      return b && b.status === 'confirmed' && b.refundable_until === f.refundable_until ? yes() : no;
    }
    case 'travel_day':
      return trip.dates?.start === f.start && trip.status !== 'over' ? yes() : no;
    case 'settle_up':
      return trip.dates?.end === f.end && trip.money.transfers.length > 0 ? yes() : no;
    case 'chat': {
      const m = pack.messages.find((x) => x.message_id === f.message_id);
      return m && !m.deleted ? yes() : no;
    }
    case 'dates_clash':
      return dateClashes(trip).some((x) => x.booking_id === f.booking_id) ? yes() : no;
    default:
      return yes();
  }
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/proactive/timers.ts apps/brain/src/proactive/timers.test.ts
git commit -m "feat(proactive): timers for votes, free cancellation, travel day, settle-up and a waiting payer

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `timers.test.ts` passes; earlier tests stay green.

### Task 4: The promoter (only what passes the bar reaches the desk)

**Files:**
- Create: `apps/brain/src/proactive/payload.ts`
- Create: `apps/brain/src/proactive/promoter.ts`
- Test: `apps/brain/src/proactive/promoter.test.ts`

**Interfaces:**
- Consumes: `ACTIONS`, `Candidate`, `Decision`, `TripMood`, `decideBatch` (Task 1); `localDay` (Task 1); `ProactiveStore`, `Signals` (Task 2); `stillTrue` (Task 3); `Desk.put`, `DeskItem` (P1); `Packs.get`, `TripPack` (P1).
- Produces:
  - `payload.ts`: `PROACTIVE_KINDS = ['timer', 'watch', 'opening'] as const`; `ProactivePayload` (zod) and its type `{ candidate: { ...Candidate with ISO strings }; allowed: Action[]; forPersonIds: string[]; tz: string }`; `toPayload(c: Candidate, d: Extract<Decision, { kind: 'go' }>, tz: string): ProactivePayload`; `fromPayload(p: ProactivePayload['candidate']): Candidate`; `proactiveOf(item: DeskItem): ProactivePayload | null`; `deskId(c: Pick<Candidate, 'tripId' | 'dedupeKey'>): string` (`pro:<trip>:<key>`).
  - `promoter.ts`: `moodFrom(sig: Signals, pack: TripPack, tz: string): TripMood`; `interface PromoterDeps { store; desk: Pick<Desk, 'put'>; packs: Pick<Packs, 'get'>; now: () => Date; log: { warn(obj: object, msg: string): void } }`; `createPromoter(deps): { tick(): Promise<number> }` (returns how many candidates went onto the desk).

The order inside a pass is crash safe: the desk item is put first (its id is stable, so a repeat put is a no-op), then the candidate is marked promoted. A crash between the two puts the same item again on the next pass and then marks it. A failure for one trip is logged and leaves that trip's candidates due for the next pass.

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/proactive/promoter.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import { candidate, fakeDesk, fakePacks, goaPack, goaTrip, manualTime, msg, seedTrip } from './fakes.js';
import { proactiveOf } from './payload.js';
import { createPromoter, moodFrom } from './promoter.js';
import { ProactiveStore } from './store.js';

const NOON = '2026-10-06T06:30:00Z';
const LATE = '2026-10-06T17:00:00Z';
const log = { warn: (): void => {} };

let db: Awaited<ReturnType<typeof withSchema>>;
let store: ProactiveStore;
beforeAll(async () => {
  db = await withSchema();
  store = new ProactiveStore(db.pool);
  for (const t of ['t_goa', 't_full', 't_late']) await seedTrip(db.pool, t);
});
afterAll(async () => {
  await db.drop();
});

const packs = fakePacks(
  goaPack(),
  goaPack({ trip: goaTrip({ trip_id: 't_full' }) }),
  goaPack({ trip: goaTrip({ trip_id: 't_late' }) }),
);

describe('moodFrom', () => {
  it('reads paused people and the last person message from the pack', () => {
    const base = goaTrip();
    const trip = goaTrip({ people: base.people.map((p) => (p.person_id === 'p_meher' ? { ...p, go_paused: true } : p)) });
    const pack = goaPack({
      trip,
      messages: [
        msg({ by: 'p_priya', sentAt: '2026-10-06T06:00:00Z' }),
        msg({ by: 'go', sentAt: '2026-10-06T06:05:00Z' }),
      ],
    });
    const m = moodFrom({ postsToday: 1, lastProactivePostAt: null, hushCount: 0, lastHushAt: null, ignoredCount: 0 }, pack, 'Asia/Kolkata');
    expect(m.pausedPersonIds).toEqual(['p_meher']);
    expect(m.lastPersonMessageAt?.toISOString()).toBe('2026-10-06T06:00:00.000Z');
    expect(m.postsToday).toBe(1);
  });
});

describe('createPromoter', () => {
  it('puts a passing candidate on the desk once, with what the bar allowed', async () => {
    const time = manualTime(NOON);
    const desk = fakeDesk();
    const p = createPromoter({ store, desk, packs, now: time.now, log });
    await store.add(candidate({ dedupeKey: 'delay:1', dueAt: new Date(Date.parse(NOON) - 1000) }));
    await store.add(candidate({ dedupeKey: 'later:1', dueAt: new Date(Date.parse(NOON) + 60_000) }));

    expect(await p.tick()).toBe(1);
    expect(await p.tick()).toBe(0);
    expect(desk.items).toHaveLength(1);
    const item = desk.items[0]!;
    expect(item).toMatchObject({ id: 'pro:t_goa:delay:1', tripId: 't_goa', kind: 'watch', ref: 'pro:t_goa:delay:1' });
    expect(item.dueAt.toISOString()).toBe('2026-10-06T06:30:00.000Z');
    expect(proactiveOf(item)).toMatchObject({ allowed: ['pin'], forPersonIds: ['p_arjun'], tz: 'Asia/Kolkata' });
    expect(await store.status('t_goa', 'delay:1')).toMatchObject({ status: 'promoted', counted: true, allowed: ['pin'] });
    expect((await store.status('t_goa', 'later:1'))?.status).toBe('pending');
  });

  it('drops a candidate that is no longer true', async () => {
    const desk = fakeDesk();
    const p = createPromoter({ store, desk, packs, now: manualTime(NOON).now, log });
    await store.add(candidate({ dedupeKey: 'vote:stale', source: 'timer', topic: 'vote_closing', useful: ['pin'], facts: { decision_id: 'd_villa', closes_at: '2026-10-01T00:00:00Z' }, dueAt: new Date(Date.parse(NOON) - 1000) }));
    await p.tick();
    expect(desk.items).toHaveLength(0);
    expect(await store.status('t_goa', 'vote:stale')).toMatchObject({ status: 'dropped', reason: 'no_longer_true' });
  });

  it('waits for tomorrow morning once the day budget is spent', async () => {
    const desk = fakeDesk();
    const now = new Date(NOON);
    for (let i = 0; i < 3; i += 1) {
      const c = candidate({ tripId: 't_full', dedupeKey: `spent:${i}` });
      await store.add(c);
      await store.promote(c, { allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true, localDay: '2026-10-06' }, new Date(now.getTime() - (i + 1) * 3600_000));
    }
    const pack = goaPack({ trip: goaTrip({ trip_id: 't_full' }), messages: [msg({ by: 'p_priya', sentAt: '2026-10-06T06:20:00Z' })] });
    const p = createPromoter({ store, desk, packs: fakePacks(pack), now: () => now, log });
    await store.add(candidate({ tripId: 't_full', dedupeKey: 'over:1', useful: ['pin'], dueAt: new Date(now.getTime() - 1000) }));
    await p.tick();
    expect(desk.items).toHaveLength(0);
    const s = await store.status('t_full', 'over:1');
    expect(s).toMatchObject({ status: 'pending', reason: 'budget' });
    expect(s?.dueAt.toISOString()).toBe('2026-10-07T02:30:00.000Z');
  });

  it('holds a message until 8 am at night in the trip time zone', async () => {
    const desk = fakeDesk();
    const p = createPromoter({ store, desk, packs, now: manualTime(LATE).now, log });
    await store.add(candidate({ tripId: 't_late', dedupeKey: 'closed:1', source: 'opening', topic: 'vote_closed', importance: 0.8, urgency: 0.8, useful: ['message'], personIds: [], dueAt: new Date(Date.parse(LATE) - 1000) }));
    await p.tick();
    expect(desk.items).toHaveLength(0);
    const s = await store.status('t_late', 'closed:1');
    expect(s).toMatchObject({ status: 'pending', reason: 'night' });
    expect(s?.dueAt.toISOString()).toBe('2026-10-07T02:30:00.000Z');
  });

  it('joins a pass already running instead of running two', async () => {
    const desk = fakeDesk();
    const p = createPromoter({ store, desk, packs, now: manualTime(NOON).now, log });
    await store.add(candidate({ dedupeKey: 'join:1', personIds: [], useful: ['react'], dueAt: new Date(Date.parse(NOON) - 1000) }));
    const [a, b] = await Promise.all([p.tick(), p.tick()]);
    expect(a).toBe(b);
    expect(desk.items.filter((i) => i.id === 'pro:t_goa:join:1')).toHaveLength(1);
  });

  it('keeps a trip due when its pack cannot be read', async () => {
    const warned: object[] = [];
    const desk = fakeDesk();
    await seedTrip(db.pool, 't_ghost');
    const p = createPromoter({ store, desk, packs: fakePacks(), now: manualTime(NOON).now, log: { warn: (o: object) => { warned.push(o); } } });
    await store.add(candidate({ tripId: 't_ghost', dedupeKey: 'ghost:1', dueAt: new Date(Date.parse(NOON) - 1000) }));
    await p.tick();
    expect(warned.length).toBeGreaterThan(0);
    expect((await store.status('t_ghost', 'ghost:1'))?.status).toBe('pending');
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the modules do not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/brain/src/proactive/payload.ts
// What a proactive desk item carries: what Go noticed, what the bar allows this turn, and the trip's zone.
import { z } from 'zod';
import type { DeskItem } from '../desk/desk.js';
import { ACTIONS, type Candidate, type Decision } from './policy.js';

export const PROACTIVE_KINDS = ['timer', 'watch', 'opening'] as const;
const When = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'a date');

export const ProactivePayload = z.object({
  candidate: z.object({
    tripId: z.string(),
    dedupeKey: z.string(),
    source: z.enum(PROACTIVE_KINDS),
    topic: z.string(),
    dueAt: When,
    expiresAt: When.nullable(),
    importance: z.number(),
    confidence: z.number(),
    urgency: z.number(),
    useful: z.array(z.enum(ACTIONS)),
    personIds: z.array(z.string()),
    facts: z.record(z.string(), z.unknown()),
    simulated: z.boolean(),
    small: z.boolean(),
  }),
  allowed: z.array(z.enum(ACTIONS)).min(1),
  forPersonIds: z.array(z.string()),
  tz: z.string(),
});
export type ProactivePayload = z.infer<typeof ProactivePayload>;

export function toPayload(c: Candidate, d: Extract<Decision, { kind: 'go' }>, tz: string): ProactivePayload {
  return {
    candidate: { ...c, dueAt: c.dueAt.toISOString(), expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null },
    allowed: d.allowed,
    forPersonIds: d.forPersonIds,
    tz,
  };
}

export function fromPayload(p: ProactivePayload['candidate']): Candidate {
  return { ...p, dueAt: new Date(p.dueAt), expiresAt: p.expiresAt ? new Date(p.expiresAt) : null };
}

/** The proactive payload of a desk item, or null when a person, a tap or a task put the item there. */
export function proactiveOf(item: DeskItem): ProactivePayload | null {
  if (!(PROACTIVE_KINDS as readonly string[]).includes(item.kind)) return null;
  const r = ProactivePayload.safeParse(item.payload);
  return r.success ? r.data : null;
}

export const deskId = (c: Pick<Candidate, 'tripId' | 'dedupeKey'>): string => `pro:${c.tripId}:${c.dedupeKey}`;
```

```ts
// apps/brain/src/proactive/promoter.ts
// Moves due candidates through the bar onto the desk. Only a candidate that passes becomes a desk item,
// so a nudge the bar refuses never costs a model turn.
import type { Desk } from '../desk/desk.js';
import type { Packs, TripPack } from '../trips/pack.js';
import { localDay } from './clock.js';
import { deskId, toPayload } from './payload.js';
import { decideBatch, type Candidate, type TripMood } from './policy.js';
import type { ProactiveStore, Signals } from './store.js';
import { stillTrue } from './timers.js';

export function moodFrom(sig: Signals, pack: TripPack, tz: string): TripMood {
  let lastPerson: string | null = null;
  for (const m of pack.messages) {
    if (m.author.kind === 'person' && !m.deleted && (lastPerson === null || m.sent_at > lastPerson)) lastPerson = m.sent_at;
  }
  return {
    tz,
    postsToday: sig.postsToday,
    lastProactivePostAt: sig.lastProactivePostAt,
    lastPersonMessageAt: lastPerson ? new Date(lastPerson) : null,
    hushCount: sig.hushCount,
    lastHushAt: sig.lastHushAt,
    ignoredCount: sig.ignoredCount,
    pausedPersonIds: pack.trip.people.filter((p) => p.go_paused).map((p) => p.person_id),
  };
}

export interface PromoterDeps {
  store: ProactiveStore;
  desk: Pick<Desk, 'put'>;
  packs: Pick<Packs, 'get'>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
}

export function createPromoter(deps: PromoterDeps): { tick(): Promise<number> } {
  let running: Promise<number> | null = null;

  async function promoteTrip(tripId: string, cands: Candidate[], now: Date): Promise<number> {
    const pack = await deps.packs.get(tripId);
    const tz = await deps.store.tripTz(tripId);
    const day = localDay(now, tz);
    const mood = moodFrom(await deps.store.signals(tripId, day), pack, tz);
    const live: Candidate[] = [];
    for (const c of cands) {
      const check = stillTrue(c, pack);
      if (!check.ok) {
        await deps.store.drop(c, 'no_longer_true', now);
        continue;
      }
      live.push({ ...c, personIds: check.personIds });
    }
    let promoted = 0;
    for (const { candidate, decision } of decideBatch(live, mood, now)) {
      if (decision.kind === 'drop') {
        await deps.store.drop(candidate, decision.reason, now);
        continue;
      }
      if (decision.kind === 'wait') {
        await deps.store.defer(candidate, decision.until, decision.reason);
        continue;
      }
      const id = deskId(candidate);
      await deps.desk.put({ id, tripId, kind: candidate.source, ref: id, dueAt: now, payload: toPayload(candidate, decision, tz) });
      await deps.store.promote(candidate, { allowed: decision.allowed, forPersonIds: decision.forPersonIds, counted: decision.counted, localDay: day }, now);
      promoted += 1;
    }
    return promoted;
  }

  async function once(): Promise<number> {
    const now = deps.now();
    const byTrip = new Map<string, Candidate[]>();
    for (const c of await deps.store.due(now)) byTrip.set(c.tripId, [...(byTrip.get(c.tripId) ?? []), c]);
    let promoted = 0;
    for (const [tripId, cands] of byTrip) {
      try {
        promoted += await promoteTrip(tripId, cands, now);
      } catch (err) {
        deps.log.warn({ err, tripId }, 'proactive: promote failed; the candidates stay due');
      }
    }
    return promoted;
  }

  return {
    /** One pass. A pass already running is joined, never doubled. */
    tick(): Promise<number> {
      if (!running) running = once().finally(() => { running = null; });
      return running;
    },
  };
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/proactive/payload.ts apps/brain/src/proactive/promoter.ts apps/brain/src/proactive/promoter.test.ts
git commit -m "feat(proactive): only a nudge that passes the bar reaches the desk, once, with what it may do

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `promoter.test.ts` passes; earlier tests stay green.

### Task 5: What a proactive turn sees and may do (wake text, the "openings" block, the notice tools)

**Files:**
- Create: `apps/brain/src/proactive/words.ts`
- Create: `apps/brain/src/proactive/allowed.ts`
- Create: `apps/brain/src/proactive/wake.ts`
- Create: `apps/brain/src/proactive/notice-tools.ts`
- Test: `apps/brain/src/proactive/wake.test.ts`
- Test: `apps/brain/src/proactive/notice-tools.test.ts`

**Interfaces:**
- Consumes: `Action`, `Candidate` (Task 1); `localWhen` (Task 1); `ProactiveStore`, `NoticeIn` (Task 2); `ProactivePayload`, `proactiveOf`, `fromPayload`, `toPayload`, `deskId` (Task 4); `DeskItem` (P1); `NowProvider` (P1); `QuickTool`, `TurnCtx` (P1); `newRequestId()` (P1); `TripPack` (P1); `NoticeCard` (`@go/contract`).
- Produces:
  - `words.ts`: `plain(text): string`; `clip(text, max): string`; `quote(text, max?): string`; `rupees(minor): string`; `namesOf(ids, people): string`.
  - `allowed.ts`: `TOOLS_FOR: Record<Action, readonly string[]>`; `ALWAYS: readonly string[]` (`stay_silent`, `trip`, `person`, `recall`); `interface TurnRules { allowed: Action[]; tools: string[]; mayPostText: boolean; pinOnlyFor: string[] | null; dedupeKeys: string[] }`; `rulesForTurn(wake: DeskItem[]): TurnRules | null` (null when anything other than Go's own noticing woke the turn); `simulatedIn(wake: DeskItem[]): boolean`.
  - `wake.ts`: `describeNoticed(c, pack, tz, now): string`; `renderWake(item, pack, now): string`; `OPENINGS_ORDER = 60`; `openingsNow(): NowProvider` (name `openings`).
  - `notice-tools.ts`: `SIMULATED_SOURCE = 'Simulated for the demo'`; `interface NoticeToolDeps { store: ProactiveStore; now: () => Date; onPosted?: (p: ProactivePayload, cardId: string) => Promise<void> }`; `noticeTools(deps): [QuickTool<PostNoticeArgs>, QuickTool<UpdateNoticeArgs>]` (tools `post_notice`, `update_notice`).

How the limits are enforced today, without changing P1: (1) the wake text names exactly what is allowed; (2) the `openings` block lists the tools this turn may use and whether a text message is allowed; (3) `post_notice` and `update_notice` refuse anything the bar did not allow, keep pins to the people the bar named, strip anyone who paused Go, and force the "Simulated for the demo" source whenever a simulated item is in the turn, even when a person's message woke the same turn. The composer's own tools and plain text are limited only by (1) and (2) until P1 adds `TurnCtx.allowedTools` (see the interface notes); `rulesForTurn` is the function P1 calls for it.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/brain/src/proactive/wake.test.ts
import { describe, expect, it } from 'vitest';
import type { DeskItem } from '../desk/desk.js';
import { ALWAYS, rulesForTurn, simulatedIn } from './allowed.js';
import { candidate, goaPack, goaTrip } from './fakes.js';
import { deskId, toPayload } from './payload.js';
import type { Action, Candidate } from './policy.js';
import { describeNoticed, openingsNow, renderWake } from './wake.js';
import { clip, namesOf, plain, quote, rupees } from './words.js';

const NOW = new Date('2026-10-06T06:30:00Z');
function proItem(c: Candidate, allowed: Action[], forPersonIds: string[] = []): DeskItem {
  const id = deskId(c);
  return {
    id, tripId: c.tripId, kind: c.source, ref: id, dueAt: NOW,
    payload: toPayload(c, { kind: 'go', allowed, forPersonIds, counted: true, score: 1, bar: 0 }, 'Asia/Kolkata'),
  };
}
const messageItem: DeskItem = { id: 'msg:1', tripId: 't_goa', kind: 'message', ref: 'm_1', dueAt: NOW, payload: {} };
const delay = candidate({
  dedupeKey: 'sim:flight_status:ab12',
  simulated: true,
  facts: { label: 'IndiGo 6E 2134', status: 'delayed', delayMinutes: 120, arriveAt: '2026-11-06T22:45:00+05:30', note: "Arjun's airport cab is booked for 9 pm", simulated: true },
});
const chat = candidate({ dedupeKey: 'chat:m_9', source: 'opening', topic: 'chat', personIds: [], useful: ['react', 'record', 'message'], facts: { message_id: 'm_9', seq: 9 } });

describe('words', () => {
  it('keeps em dashes and vendor names out of what people see', () => {
    expect(plain('Villa Sol — 3 nights, 6–9 Nov')).toBe('Villa Sol, 3 nights, 6 to 9 Nov');
    expect(plain('I run on OpenAI GPT-5 and ChatGPT')).not.toMatch(/openai|gpt|chatgpt/i);
  });

  it('clips, quotes as data, writes rupees and names', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('abc', 4)).toBe('abc');
    expect(quote('say "hi"')).toBe('"say \\"hi\\""');
    expect(rupees(5420000)).toBe('₹54,200');
    const people = goaTrip().people;
    expect(namesOf(['p_arjun'], people)).toBe('Arjun');
    expect(namesOf(['p_arjun', 'p_meher'], people)).toBe('Arjun and Meher');
    expect(namesOf(['p_arjun', 'p_meher', 'p_kabir'], people)).toBe('Arjun, Meher and Kabir');
  });
});

describe('rulesForTurn', () => {
  it('applies only when nothing but Go noticing woke the turn', () => {
    expect(rulesForTurn([messageItem, proItem(delay, ['pin'], ['p_arjun'])])).toBeNull();
    expect(rulesForTurn([])).toBeNull();
  });

  it('allows a pin for Arjun and nothing louder', () => {
    const r = rulesForTurn([proItem(delay, ['pin'], ['p_arjun'])]);
    expect(r).toMatchObject({ allowed: ['pin'], mayPostText: false, pinOnlyFor: ['p_arjun'], dedupeKeys: ['sim:flight_status:ab12'] });
    for (const t of ALWAYS) expect(r?.tools).toContain(t);
    expect(r?.tools).toContain('post_notice');
    expect(r?.tools).not.toContain('react');
    expect(r?.tools).not.toContain('call_business');
    expect(r?.tools).not.toContain('start_task');
  });

  it('allows quiet tools and one message for a chat opening', () => {
    const r = rulesForTurn([proItem(chat, ['react', 'record', 'message'])]);
    expect(r).toMatchObject({ mayPostText: true, pinOnlyFor: null });
    expect(r?.tools).toEqual(expect.arrayContaining(['react', 'record', 'post_notice', 'stay_silent']));
  });

  it('notices a simulated item even in a turn a person woke', () => {
    expect(simulatedIn([messageItem, proItem(delay, ['pin'], ['p_arjun'])])).toBe(true);
    expect(simulatedIn([messageItem])).toBe(false);
  });
});

describe('the wake text', () => {
  it('says the demo watch is simulated, pinned to Arjun, and not for everyone', () => {
    const text = renderWake(proItem(delay, ['pin'], ['p_arjun']), goaPack(), NOW);
    expect(text).toContain('Simulated for the demo');
    expect(text).toContain('running 120 minutes late');
    expect(text).toContain("Arjun's airport cab");
    expect(text).toContain('["p_arjun"]');
    expect(text).toContain('Do not post a message to everyone');
    expect(text).toContain('Suggest, never act');
    expect(text).not.toContain('—');
  });

  it('names who has not voted, and when the vote closes', () => {
    const c = candidate({ source: 'timer', topic: 'vote_closing', personIds: ['p_arjun', 'p_meher'], facts: { decision_id: 'd_villa', closes_at: '2026-10-06T12:30:00Z' } });
    const text = describeNoticed(c, goaPack(), 'Asia/Kolkata', NOW);
    expect(text).toContain('"Where do we stay?"');
    expect(text).toContain('Not voted yet: Arjun and Meher');
    expect(text).toContain('in about 6 hours');
  });

  it('says how much is at stake when free cancellation ends', () => {
    const c = candidate({ source: 'timer', topic: 'free_cancel', personIds: ['p_rahul'], facts: { booking_id: 'b_villa', refundable_until: '2026-11-01T18:29:59Z' } });
    expect(describeNoticed(c, goaPack(), 'Asia/Kolkata', NOW)).toContain('₹54,200');
  });
});

describe('the openings block', () => {
  const now = openingsNow();
  it('stays out of a turn Go did not wake for itself', async () => {
    expect(now.name).toBe('openings');
    expect(await now.render('t_goa', [messageItem])).toBeNull();
  });

  it('lists the tools a proactive turn may use', async () => {
    const text = await now.render('t_goa', [proItem(delay, ['pin'], ['p_arjun'])]);
    expect(text).toContain('Tools you may use');
    expect(text).toContain('Do not post a text message');
  });

  it('lets a noticed item ride along when a person woke Go too', async () => {
    expect(await now.render('t_goa', [messageItem, proItem(delay, ['pin'], ['p_arjun'])])).toContain('normal rules apply');
  });
});
```

```ts
// apps/brain/src/proactive/notice-tools.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import type { DeskItem } from '../desk/desk.js';
import { candidate, fakeLink, goaPack, goaTrip, seedTrip, turnCtx } from './fakes.js';
import { SIMULATED_SOURCE, noticeTools } from './notice-tools.js';
import { deskId, toPayload, type ProactivePayload } from './payload.js';
import type { Action, Candidate } from './policy.js';
import { ProactiveStore } from './store.js';

const NOW = new Date('2026-10-06T06:30:00Z');
function proItem(c: Candidate, allowed: Action[], forPersonIds: string[] = []): DeskItem {
  const id = deskId(c);
  return { id, tripId: c.tripId, kind: c.source, ref: id, dueAt: NOW, payload: toPayload(c, { kind: 'go', allowed, forPersonIds, counted: true, score: 1, bar: 0 }, 'Asia/Kolkata') };
}
const messageItem: DeskItem = { id: 'msg:1', tripId: 't_goa', kind: 'message', ref: 'm_1', dueAt: NOW, payload: {} };

let db: Awaited<ReturnType<typeof withSchema>>;
let store: ProactiveStore;
const posted: Array<{ p: ProactivePayload; cardId: string }> = [];
beforeAll(async () => {
  db = await withSchema();
  store = new ProactiveStore(db.pool);
  await seedTrip(db.pool, 't_goa');
});
afterAll(async () => {
  await db.drop();
});

const tools = () => noticeTools({ store, now: () => NOW, onPosted: async (p, cardId) => { posted.push({ p, cardId }); } });

describe('post_notice', () => {
  it('pins the simulated delay to Arjun only and labels it, whatever the model asked', async () => {
    const delay = candidate({ dedupeKey: 'sim:flight_status:1', simulated: true });
    await store.add(delay);
    const [post] = tools();
    const link = fakeLink();
    const ctx = turnCtx({ link, pack: goaPack(), wake: [proItem(delay, ['pin'], ['p_arjun'])] });
    const out = await post.run(
      post.input.parse({ tone: 'heads_up', title: 'Your flight is 2 hours late — cab at 9', body: 'Your cab is at 9 pm but you now land at 10:45. Want me to move it to 11?', for_person_ids: ['p_rahul', 'p_arjun'], source_name: 'ixigo' }),
      ctx,
    );
    expect(out).toMatchObject({ posted: true, pinned_for: ['p_arjun'] });
    const [sent] = link.of('post_message');
    const card = sent?.card as Record<string, unknown>;
    expect(card).toMatchObject({ kind: 'notice', tone: 'heads_up', for_person_ids: ['p_arjun'], source: { name: SIMULATED_SOURCE } });
    expect(String(card.title)).not.toContain('—');
    expect(String(sent?.request_id)).toMatch(/^go_/);
    expect(ctx.outcome.spoke).toBe(true);
    expect((await store.status('t_goa', 'sim:flight_status:1'))?.postedMessageId).toBe('m_go_1');
    expect(await store.notice('t_goa', String(card.card_id))).not.toBeNull();
    expect(posted.at(-1)?.cardId).toBe(card.card_id);
  });

  it('pins to the people the bar named when the model forgets to', async () => {
    const c = candidate({ dedupeKey: 'free:1', source: 'timer', topic: 'free_cancel', personIds: ['p_rahul'] });
    const [post] = tools();
    const link = fakeLink();
    await post.run(post.input.parse({ tone: 'heads_up', title: 'Free cancellation ends tomorrow', body: 'Villa Sol is free to cancel until Sunday night.' }), turnCtx({ link, pack: goaPack(), wake: [proItem(c, ['pin'], ['p_rahul'])] }));
    expect((link.of('post_message')[0]?.card as Record<string, unknown>).for_person_ids).toEqual(['p_rahul']);
  });

  it('refuses when the bar allowed only quiet actions', async () => {
    const c = candidate({ dedupeKey: 'quiet:1', source: 'opening', topic: 'chat', personIds: [] });
    const [post] = tools();
    const link = fakeLink();
    const out = await post.run(post.input.parse({ tone: 'info', title: 'Hi', body: 'Hello' }), turnCtx({ link, pack: goaPack(), wake: [proItem(c, ['react'])] }));
    expect(out).toHaveProperty('refused');
    expect(link.calls).toHaveLength(0);
  });

  it('never pins someone who paused Go', async () => {
    const base = goaTrip();
    const trip = goaTrip({ people: base.people.map((p) => (p.person_id === 'p_arjun' ? { ...p, go_paused: true } : p)) });
    const c = candidate({ dedupeKey: 'paused:1' });
    const [post] = tools();
    const link = fakeLink();
    const out = await post.run(post.input.parse({ tone: 'heads_up', title: 'Late', body: 'Late flight' }), turnCtx({ link, pack: goaPack({ trip }), wake: [proItem(c, ['pin'], ['p_arjun'])] }));
    expect(out).toHaveProperty('refused');
    expect(link.calls).toHaveLength(0);
  });

  it('labels a simulated item even in a turn a person woke, and strips paused people there too', async () => {
    const base = goaTrip();
    const trip = goaTrip({ people: base.people.map((p) => (p.person_id === 'p_meher' ? { ...p, go_paused: true } : p)) });
    const delay = candidate({ dedupeKey: 'sim:flight_status:2', simulated: true });
    const [post] = tools();
    const link = fakeLink();
    await post.run(
      post.input.parse({ tone: 'heads_up', title: 'Late flight', body: 'Two hours late.', for_person_ids: ['p_arjun', 'p_meher'] }),
      turnCtx({ link, pack: goaPack({ trip }), wake: [messageItem, proItem(delay, ['pin'], ['p_arjun'])] }),
    );
    const card = link.of('post_message')[0]?.card as Record<string, unknown>;
    expect(card.source).toEqual({ name: SIMULATED_SOURCE });
    expect(card.for_person_ids).toEqual(['p_arjun']);
  });
});

describe('update_notice', () => {
  it('replaces a notice Go posted, in place', async () => {
    const delay = candidate({ dedupeKey: 'sim:flight_status:3', simulated: true });
    const [post, update] = tools();
    const link = fakeLink();
    const ctx = turnCtx({ link, pack: goaPack(), wake: [proItem(delay, ['pin'], ['p_arjun'])] });
    const out = (await post.run(post.input.parse({ tone: 'heads_up', title: 'Late flight', body: 'Two hours late.' }), ctx)) as { card_id: string };
    const ctx2 = turnCtx({ link, pack: goaPack(), wake: [proItem({ ...delay, dedupeKey: 'sim:flight_status:4' }, ['update_card'])] });
    expect(await update.run(update.input.parse({ card_id: out.card_id, body: 'Three hours late now.' }), ctx2)).toMatchObject({ updated: true });
    const replaced = link.of('replace_card')[0]?.card as Record<string, unknown>;
    expect(replaced).toMatchObject({ card_id: out.card_id, body: 'Three hours late now.', source: { name: SIMULATED_SOURCE } });
  });

  it('refuses a card it does not know', async () => {
    const [, update] = tools();
    const out = await update.run(update.input.parse({ card_id: 'c_nope', body: 'x' }), turnCtx({ link: fakeLink(), pack: goaPack(), wake: [messageItem] }));
    expect(out).toHaveProperty('refused');
  });
});
```

- [ ] **Step 2: Push the tests and see them fail**

Red is certain: the modules do not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/brain/src/proactive/words.ts
// Go's words in the room: no em dashes, never a model vendor's name, and people's text quoted as data.
const VENDOR = /\b(open\s?ai|chat\s?gpt|gpt[-\w.]*|anthropic|claude|gemini)\b/gi;

export function plain(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[—―–]\s*/g, ', ')
    .replace(VENDOR, 'Go')
    .replace(/ {2,}/g, ' ')
    .replace(/ ,/g, ',')
    .trim();
}

/** Cuts to at most `max` UTF-16 units (what the contract's zod limits count), never inside an emoji. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** People's text inside Go's own prompt lines, as a JSON string: it cannot close the quote or pose as Go. */
export function quote(text: string, max = 120): string {
  return JSON.stringify(clip(text, max));
}

export function rupees(minor: number): string {
  return `₹${Math.round(minor / 100).toLocaleString('en-IN')}`;
}

export function namesOf(ids: string[], people: ReadonlyArray<{ person_id: string; name: string }>): string {
  const names = ids.map((id) => people.find((p) => p.person_id === id)?.name ?? 'someone');
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0] ?? 'someone';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? 'someone'}`;
}
```

```ts
// apps/brain/src/proactive/allowed.ts
// The tools a proactive turn may use. A turn woken only by things Go noticed itself gets the actions the
// bar allowed and nothing else. A turn a person (or a tap, or a task) woke follows the normal rules: null.
import type { DeskItem } from '../desk/desk.js';
import { proactiveOf } from './payload.js';
import { ACTIONS, type Action } from './policy.js';

/** Tool names: `react` and `record` (P2), `post_notice` and `update_notice` (this plan). */
export const TOOLS_FOR: Readonly<Record<Action, readonly string[]>> = {
  react: ['react'],
  record: ['record'],
  update_card: ['update_notice'],
  pin: ['post_notice'],
  message: ['post_notice'],
};
/** Reading and staying silent are always fine. */
export const ALWAYS: readonly string[] = ['stay_silent', 'trip', 'person', 'recall'];

export interface TurnRules {
  allowed: Action[];
  tools: string[];
  mayPostText: boolean;
  /** Set when posts may only be pins: the people the bar named. */
  pinOnlyFor: string[] | null;
  dedupeKeys: string[];
}

export function rulesForTurn(wake: DeskItem[]): TurnRules | null {
  if (wake.length === 0) return null;
  const payloads = wake.map(proactiveOf);
  const allowed = new Set<Action>();
  const pins = new Set<string>();
  const dedupeKeys: string[] = [];
  for (const p of payloads) {
    if (p === null) return null;
    for (const a of p.allowed) allowed.add(a);
    for (const id of p.forPersonIds) pins.add(id);
    dedupeKeys.push(p.candidate.dedupeKey);
  }
  const tools = new Set<string>(ALWAYS);
  for (const a of allowed) for (const t of TOOLS_FOR[a]) tools.add(t);
  const mayPostText = allowed.has('message');
  return {
    allowed: ACTIONS.filter((a) => allowed.has(a)),
    tools: [...tools],
    mayPostText,
    pinOnlyFor: !mayPostText && allowed.has('pin') ? [...pins] : null,
    dedupeKeys,
  };
}

export function simulatedIn(wake: DeskItem[]): boolean {
  return wake.some((item) => proactiveOf(item)?.candidate.simulated === true);
}
```

```ts
// apps/brain/src/proactive/wake.ts
// How something Go noticed reads in "why Go woke", and the "openings" block with this turn's rules.
import type { NowProvider } from '../composer/context.js';
import type { DeskItem } from '../desk/desk.js';
import type { TripPack } from '../trips/pack.js';
import { rulesForTurn } from './allowed.js';
import { localWhen } from './clock.js';
import { fromPayload, proactiveOf } from './payload.js';
import type { Action, Candidate } from './policy.js';
import { namesOf, quote, rupees } from './words.js';

const H = 3600_000;

function inAbout(at: Date, now: Date): string {
  const h = Math.round((at.getTime() - now.getTime()) / H);
  if (h <= 1) return 'within the hour';
  if (h < 48) return `in about ${h} hours`;
  return `in about ${Math.round(h / 24)} days`;
}

function ago(iso: string, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (m < 1) return 'just now';
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** What Go noticed, in plain words. People's text and names from the trip are quoted as data. */
export function describeNoticed(c: Candidate, pack: TripPack, tz: string, now: Date): string {
  const trip = pack.trip;
  const f = c.facts;
  const str = (k: string): string => (typeof f[k] === 'string' ? (f[k] as string) : '');
  const num = (k: string): number | null => (typeof f[k] === 'number' ? (f[k] as number) : null);
  const at = (k: string): Date | null => {
    const t = Date.parse(str(k));
    return Number.isNaN(t) ? null : new Date(t);
  };
  const who = (ids: string[]): string => namesOf(ids, trip.people);
  const decision = trip.decisions.find((d) => d.decision_id === str('decision_id'));
  const booking = trip.bookings.find((b) => b.booking_id === str('booking_id'));

  switch (c.topic) {
    case 'vote_closing': {
      const closes = at('closes_at');
      const when = closes ? ` closes ${localWhen(closes, tz)} (${inAbout(closes, now)})` : ' closes soon';
      const missing = c.personIds.length > 0
        ? ` Not voted yet: ${who(c.personIds)}.`
        : decision ? ` ${decision.of - decision.voted} people have not voted yet.` : '';
      return `The vote ${quote(decision?.question ?? 'on the table')}${when}.${missing}`;
    }
    case 'payer_waiting':
      return `${who(c.personIds)} has not tapped "Yes, book it" on ${quote(decision?.question ?? 'the vote')} for a day.`;
    case 'free_cancel': {
      const until = at('refundable_until');
      const money = booking ? ` After that the ${rupees(booking.amount_minor)} is not refunded.` : '';
      return `Free cancellation on ${quote(booking?.title ?? 'a booking')} ends ${until ? `${localWhen(until, tz)} (${inAbout(until, now)})` : 'soon'}.${money}`;
    }
    case 'travel_day':
      return `Tomorrow (${str('start')}) is travel day. The group may want the plan for the day: who leaves when, and what is booked.`;
    case 'settle_up':
      return `The trip is over and ${trip.money.transfers.length} payments are still open in settle-up.`;
    case 'flight_status': {
      const delay = num('delayMinutes');
      const state = str('status') === 'cancelled'
        ? 'is cancelled'
        : delay !== null && delay > 0 ? `is running ${delay} minutes late` : 'is back on time';
      const arrive = at('arriveAt');
      const note = str('note') ? ` Also: ${quote(str('note'), 200)}` : '';
      const concerns = c.personIds.length > 0 ? ` It concerns ${who(c.personIds)}.` : '';
      return `${quote(str('label') || 'A flight')} ${state}${arrive ? `, now landing ${localWhen(arrive, tz)}` : ''}.${note}${concerns}`;
    }
    case 'fare': {
      const before = num('beforeMinor');
      const after = num('priceMinor');
      const checked = str('checkedAt');
      return `The price of ${quote(str('label') || 'an option')} moved${before !== null ? ` from ${rupees(before)}` : ''}${after !== null ? ` to ${rupees(after)}` : ''}${checked ? ` (checked ${ago(checked, now)})` : ''}.`;
    }
    case 'availability':
      return f.available === false
        ? `${quote(str('label') || 'A stay')} is no longer available.`
        : `${quote(str('label') || 'A stay')} has only ${num('left') ?? 'a few'} left.`;
    case 'chat':
      return `Message #${num('seq') ?? '?'} may be a moment to help without being asked: a question to the group Go can answer, a plan clash, or someone asking for help.`;
    case 'vote_closed': {
      const winner = str('winner');
      return `The vote ${quote(str('question') || 'on the table')} closed${winner ? `; ${quote(winner)} won` : ' without a clear winner'}. The group may want the next step.`;
    }
    case 'booking_cancelled': {
      const by = str('by');
      return `${quote(str('title') || 'A booking')} was cancelled${by ? ` by ${who([by])}` : ''}.`;
    }
    case 'dates_clash':
      return `The trip dates are now ${str('start')} to ${str('end')}, but ${quote(str('title') || 'a booking')} starts ${str('starts_at').slice(0, 10)}${str('ends_at') ? ` and ends ${str('ends_at').slice(0, 10)}` : ''}.`;
    default:
      return `Go noticed: ${quote(JSON.stringify(f), 300)}.`;
  }
}

const ACTION_WORDS: Readonly<Record<Action, string>> = {
  react: 'a quiet reaction (react)',
  record: 'a line in the trip record (record)',
  update_card: 'updating the notice Go posted earlier (update_notice)',
  pin: 'a notice card pinned only for the people it concerns (post_notice with for_person_ids)',
  message: 'one short message to the group',
};

export function renderWake(item: DeskItem, pack: TripPack, now: Date): string {
  const p = proactiveOf(item);
  if (!p) return 'Go noticed something, but its details could not be read. Call stay_silent.';
  const c = fromPayload(p.candidate);
  const lead = c.simulated ? 'Simulated for the demo. ' : '';
  const allowed = p.allowed.map((a) => ACTION_WORDS[a]).join('; ');
  const pin = p.allowed.includes('pin') && p.forPersonIds.length > 0
    ? ` Pin it only for ${namesOf(p.forPersonIds, pack.trip.people)}: for_person_ids ${JSON.stringify(p.forPersonIds)}.`
    : '';
  const notice = p.allowed.includes('update_card') && typeof c.facts.noticeCardId === 'string'
    ? ` The earlier notice is card_id ${JSON.stringify(c.facts.noticeCardId)}.`
    : '';
  const loud = p.allowed.includes('message') ? ' At most one short message.' : ' Do not post a message to everyone.';
  return `${lead}Go noticed this itself, nobody asked: ${describeNoticed(c, pack, p.tz, now)} Allowed: ${allowed}.${pin}${notice}${loud} Suggest, never act.`;
}

export const OPENINGS_ORDER = 60;

export function openingsNow(): NowProvider {
  return {
    name: 'openings',
    order: OPENINGS_ORDER,
    async render(_tripId: string, wake: DeskItem[]): Promise<string | null> {
      if (!wake.some((i) => proactiveOf(i) !== null)) return null;
      const rules = rulesForTurn(wake);
      if (!rules) {
        return 'Someone in the group woke Go as well, so the normal rules apply. What Go noticed itself may ride along in the same short reply if it fits; never a separate message for it.';
      }
      return [
        'Go is speaking up on its own this turn. Rules for this turn:',
        `- Tools you may use: ${rules.tools.join(', ')}.`,
        rules.mayPostText ? '- You may post one short message.' : '- Do not post a text message.',
        '- Suggest, never act: offer ("Want me to move it?"). Never book, pay, cancel, start a task or call anyone on your own.',
        '- If nothing allowed fits, call stay_silent.',
      ].join('\n');
    },
  };
}
```

```ts
// apps/brain/src/proactive/notice-tools.ts
// post_notice and update_notice: Go's quick tools for a notice card. They enforce what the bar allowed,
// keep pins to the right people, never ping someone who paused Go, and label simulated news.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
import { newRequestId } from '../door/server-link.js';
import { rulesForTurn, simulatedIn } from './allowed.js';
import { proactiveOf, type ProactivePayload } from './payload.js';
import type { NoticeIn, ProactiveStore } from './store.js';
import { clip, plain } from './words.js';

export const SIMULATED_SOURCE = 'Simulated for the demo';

const PostNoticeArgs = z.object({
  tone: z.enum(['info', 'heads_up']),
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(500),
  for_person_ids: z.array(z.string().min(1).max(64)).max(30).optional(),
  deadline_at: z.iso.datetime({ offset: true }).optional(),
  source_name: z.string().min(1).max(60).optional(),
});
type PostNoticeArgs = z.infer<typeof PostNoticeArgs>;

const UpdateNoticeArgs = z.object({
  card_id: z.string().min(1).max(64),
  tone: z.enum(['info', 'heads_up']).optional(),
  title: z.string().min(1).max(80).optional(),
  body: z.string().min(1).max(500).optional(),
});
type UpdateNoticeArgs = z.infer<typeof UpdateNoticeArgs>;

export interface NoticeToolDeps {
  store: ProactiveStore;
  now: () => Date;
  /** Called once per proactive item in the turn after a notice is posted (watches remember the card). */
  onPosted?: (p: ProactivePayload, cardId: string) => Promise<void>;
}

const NOT_NOW = 'Not now: the bar for speaking up unprompted is not met for this. Use an allowed action or stay_silent.';

export function noticeTools(deps: NoticeToolDeps): [QuickTool<PostNoticeArgs>, QuickTool<UpdateNoticeArgs>] {
  const post: QuickTool<PostNoticeArgs> = {
    name: 'post_notice',
    description:
      'Post a notice card: news worth knowing, or a heads-up (a deadline, a delay, a clash). Set for_person_ids to pin it for just the people it concerns instead of the whole group.',
    input: PostNoticeArgs,
    async run(args: PostNoticeArgs, ctx: TurnCtx): Promise<unknown> {
      const rules = rulesForTurn(ctx.wake);
      if (rules && !rules.tools.includes('post_notice')) return { refused: NOT_NOW };
      const reachable = new Set(ctx.pack.trip.people.filter((p) => !p.go_paused).map((p) => p.person_id));
      let pins = (args.for_person_ids ?? []).filter((id) => reachable.has(id));
      if (rules?.pinOnlyFor) {
        const named = rules.pinOnlyFor.filter((id) => reachable.has(id));
        pins = pins.filter((id) => named.includes(id));
        if (pins.length === 0) pins = named;
        if (pins.length === 0) return { refused: 'Nobody this concerns can be pinged right now.' };
      }
      const title = clip(plain(args.title), 80);
      const body = clip(plain(args.body), 500);
      const source = simulatedIn(ctx.wake)
        ? { name: SIMULATED_SOURCE }
        : args.source_name ? { name: clip(plain(args.source_name), 60) } : null;
      const card: NoticeIn = {
        card_id: `c_notice_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        kind: 'notice',
        fallback_text: clip(`${title}. ${body}`, 300),
        tone: args.tone,
        title,
        body,
        checked_at: deps.now().toISOString(),
        ...(pins.length > 0 ? { for_person_ids: pins } : {}),
        ...(source ? { source } : {}),
        ...(args.deadline_at ? { deadline_at: args.deadline_at } : {}),
      };
      const res = await ctx.link.request('post_message', { request_id: newRequestId(), trip_id: ctx.tripId, card });
      await deps.store.saveNotice({ tripId: ctx.tripId, cardId: card.card_id, messageId: res.message_id, card });
      for (const item of ctx.wake) {
        const p = proactiveOf(item);
        if (!p) continue;
        await deps.store.posted(ctx.tripId, p.candidate.dedupeKey, res.message_id);
        await deps.onPosted?.(p, card.card_id);
      }
      ctx.outcome.spoke = true;
      ctx.outcome.posts.push(res.message_id);
      return { posted: true, card_id: card.card_id, pinned_for: pins };
    },
  };

  const update: QuickTool<UpdateNoticeArgs> = {
    name: 'update_notice',
    description: 'Update a notice card Go posted earlier, in place (the delay grew, the deadline moved). Quieter than a new message.',
    input: UpdateNoticeArgs,
    async run(args: UpdateNoticeArgs, ctx: TurnCtx): Promise<unknown> {
      const rules = rulesForTurn(ctx.wake);
      if (rules && !rules.tools.includes('update_notice')) return { refused: NOT_NOW };
      const saved = await deps.store.notice(ctx.tripId, args.card_id);
      if (!saved) return { refused: 'Go has no notice card with that id in this trip.' };
      const title = args.title ? clip(plain(args.title), 80) : saved.card.title;
      const body = args.body ? clip(plain(args.body), 500) : saved.card.body;
      const card: NoticeIn = {
        ...saved.card,
        title,
        body,
        fallback_text: clip(`${title}. ${body}`, 300),
        checked_at: deps.now().toISOString(),
        ...(args.tone ? { tone: args.tone } : {}),
        ...(simulatedIn(ctx.wake) ? { source: { name: SIMULATED_SOURCE } } : {}),
      };
      await ctx.link.request('replace_card', { trip_id: ctx.tripId, card });
      await deps.store.saveNotice({ ...saved, card });
      return { updated: true, card_id: args.card_id };
    },
  };

  return [post, update];
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/proactive/words.ts apps/brain/src/proactive/allowed.ts apps/brain/src/proactive/wake.ts apps/brain/src/proactive/notice-tools.ts apps/brain/src/proactive/wake.test.ts apps/brain/src/proactive/notice-tools.test.ts
git commit -m "feat(proactive): the wake text, this turn's rules and the notice tools that enforce them

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `wake.test.ts` and `notice-tools.test.ts` pass; earlier tests stay green.

### Task 6: Openings and signals (the chat, trip changes, hush, ignored nudges)

**Files:**
- Create: `apps/brain/src/proactive/openings.ts`
- Test: `apps/brain/src/proactive/openings.test.ts`

**Interfaces:**
- Consumes: `Candidate` (Task 1); `ProactiveStore.add`, `.hush`, `.ignored`, `.toCheckForIgnored`, `.ignoreChecked` (Task 2); `dateClashes` (Task 3); `Message`, `Trip`, `TripEvent` (P1); `ReflexRead` (P1 stub / P2); `Packs.get`, `TripPack` (P1).
- Produces: `HUSH_RE`; `CHAT_WAIT_MS = 15_000`; `CHAT_EXPIRES_MS`; `IGNORED_AFTER_MS = 6 h`; `REPLAN_ON: ReadonlySet<string>`; `talksToGo(msg, pack): boolean`; `isHush(msg, pack): boolean`; `chatOpening(msg, read, now, tripId): Candidate | null`; `tripChangeOpenings(ev: TripEvent, trip: Trip, now: Date): Candidate[]`; `wasEngaged(pack, decidedAt, postedMessageId, windowMs): boolean`; `interface OpeningsDeps { store; packs: Pick<Packs, 'get'>; readTrip(tripId): Promise<Trip>; replan(tripId: string, trip: Trip): Promise<void>; now: () => Date }`; `createOpenings(deps): { onRead(msg, read, pack): Promise<void>; onEvent(ev): Promise<void>; checkIgnored(): Promise<number> }`.

Sources (spec §8):
- **The chat.** When the reflex is sure there is an opening (`read.opening` sure true) and the message is not already for Go, a `chat` candidate is due in 15 s (so a friend who answers first is seen by the turn) and expires after 10 minutes. Useful: a reaction, a record line, or one message; the policy narrows that.
- **Trip changes.** A vote a person closed (not Go, `reason !== 'closed_by_go'`), a booking someone else cancelled, and new dates (or a new booking) that clash with a confirmed booking. `trip.updated` carries no values, so Go reads the trip with `read_trip` before checking dates. Every trip change also re-plans timers and watches through `deps.replan`.
- **Hush.** A message to Go (it mentions Go or replies to Go) that says hush, shush, be quiet, shut up, chup, chup kar, bas kar, stop pinging or too many messages raises the bar for that trip (Task 1).
- **Ignored.** Six hours after an unprompted post, if no person reacted to it, replied to it or spoke to Go since, it counts as ignored and raises the bar a little.

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/proactive/openings.test.ts
import { Event } from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import type { Trip, TripEvent } from '../door/methods.js';
import { candidate, fakePacks, goaPack, goaTrip, msg, seedTrip, unsureRead } from './fakes.js';
import { chatOpening, createOpenings, isHush, tripChangeOpenings, wasEngaged } from './openings.js';
import { ProactiveStore } from './store.js';

const NOW = new Date('2026-10-06T06:30:00Z');
const ev = (seq: number, type: string, data: unknown): TripEvent =>
  Event.parse({ event_id: `ev_${seq}`, trip_id: 't_goa', seq, occurred_at: '2026-10-06T06:30:00Z', type, data });
const sureOpening = unsureRead({ opening: { value: true, sure: true } });

describe('isHush', () => {
  const goLine = msg({ id: 'm_go', by: 'go', text: 'Want me to put it to a vote?' });
  const pack = goaPack({ messages: [goLine] });
  it('hears a hush said to Go, in English or Hinglish', () => {
    expect(isHush(msg({ by: 'p_kabir', text: '@Go chup kar yaar', mentionsGo: true }), pack)).toBe(true);
    expect(isHush(msg({ by: 'p_kabir', text: 'too many messages bro', replyTo: 'm_go' }), pack)).toBe(true);
    expect(isHush(msg({ by: 'p_kabir', text: 'Go, please be quiet for a bit', mentionsGo: true }), pack)).toBe(true);
  });
  it('ignores the same words not said to Go', () => {
    expect(isHush(msg({ by: 'p_kabir', text: 'shut up Arjun lol' }), pack)).toBe(false);
    expect(isHush(msg({ by: 'p_kabir', text: 'Go, is the beach quiet in November?', mentionsGo: true }), pack)).toBe(false);
  });
});

describe('chatOpening', () => {
  it('opens a candidate when the reflex is sure, due in 15 s', () => {
    const c = chatOpening(msg({ id: 'm_50', seq: 50, by: 'p_meher', text: 'what time is check-in?' }), sureOpening, NOW, 't_goa');
    expect(c).toMatchObject({ dedupeKey: 'chat:m_50', source: 'opening', topic: 'chat', useful: ['react', 'record', 'message'], facts: { message_id: 'm_50', seq: 50 } });
    expect(c?.dueAt.toISOString()).toBe('2026-10-06T06:30:15.000Z');
  });
  it('does nothing when unsure, when the message is for Go, or for a paused person', () => {
    expect(chatOpening(msg({ text: 'hmm' }), unsureRead(), NOW, 't_goa')).toBeNull();
    expect(chatOpening(msg({ text: '@Go check-in?', mentionsGo: true }), sureOpening, NOW, 't_goa')).toBeNull();
    expect(chatOpening(msg({ text: 'x' }), unsureRead({ opening: { value: true, sure: true }, forGo: { value: true, sure: true } }), NOW, 't_goa')).toBeNull();
    expect(chatOpening(msg({ text: null, withheld: true }), sureOpening, NOW, 't_goa')).toBeNull();
  });
});

describe('tripChangeOpenings', () => {
  const closed = { ...goaTrip().decisions[0]!, status: 'closed' as const, result_index: 0, closed_at: '2026-10-06T06:29:00Z' };
  it('notices a vote a person closed, never one Go closed', () => {
    const [c] = tripChangeOpenings(ev(130, 'decision.closed', { decision: closed, reason: 'closed_by_person' }), goaTrip(), NOW);
    expect(c).toMatchObject({ dedupeKey: 'vote_closed:d_villa', topic: 'vote_closed', useful: ['message'], facts: { winner: 'Villa Sol' } });
    expect(tripChangeOpenings(ev(131, 'decision.closed', { decision: closed, reason: 'closed_by_go' }), goaTrip(), NOW)).toEqual([]);
  });

  it('notices a booking someone else cancelled', () => {
    const booking = { ...goaTrip().bookings[0]!, status: 'cancelled' as const };
    const [c] = tripChangeOpenings(ev(132, 'booking.changed', { booking, change: 'cancelled', by: { kind: 'person', person_id: 'p_kabir' } }), goaTrip(), NOW);
    expect(c).toMatchObject({ dedupeKey: 'booking_cancelled:b_villa', facts: { by: 'p_kabir' } });
    expect(tripChangeOpenings(ev(133, 'booking.changed', { booking, change: 'cancelled', by: { kind: 'go' } }), goaTrip(), NOW)).toEqual([]);
  });

  it('notices new dates that clash with a booking', () => {
    const moved = goaTrip({ dates: { start: '2026-11-13', end: '2026-11-16' } });
    const out = tripChangeOpenings(ev(134, 'trip.updated', { by: { kind: 'person', person_id: 'p_rahul' }, changed: ['dates'] }), moved, NOW);
    expect(out.map((c) => c.dedupeKey)).toEqual(['dates_clash:b_villa:2026-11-13:2026-11-16', 'dates_clash:b_flight:2026-11-13:2026-11-16']);
    expect(tripChangeOpenings(ev(135, 'trip.updated', { by: { kind: 'person', person_id: 'p_rahul' }, changed: ['title'] }), moved, NOW)).toEqual([]);
  });
});

describe('wasEngaged', () => {
  const at = new Date('2026-10-06T06:30:00Z');
  const six = 6 * 3600_000;
  it('counts a reaction, a reply or a word to Go as engagement', () => {
    const goMsg = msg({ id: 'm_go_1', by: 'go', sentAt: '2026-10-06T06:30:05Z' });
    expect(wasEngaged(goaPack({ messages: [goMsg] }), at, 'm_go_1', six)).toBe(false);
    const reacted = msg({ id: 'm_go_1', by: 'go', sentAt: '2026-10-06T06:30:05Z', reactions: [{ emoji: '👍', person_id: 'p_arjun' }] });
    expect(wasEngaged(goaPack({ messages: [reacted] }), at, 'm_go_1', six)).toBe(true);
    const reply = msg({ by: 'p_arjun', replyTo: 'm_go_1', sentAt: '2026-10-06T07:00:00Z' });
    expect(wasEngaged(goaPack({ messages: [goMsg, reply] }), at, 'm_go_1', six)).toBe(true);
  });
  it('treats a nudge that posted nothing as nothing to ignore', () => {
    expect(wasEngaged(goaPack(), at, null, six)).toBe(true);
  });
});

describe('createOpenings', () => {
  let db: Awaited<ReturnType<typeof withSchema>>;
  let store: ProactiveStore;
  const replanned: string[] = [];
  beforeAll(async () => {
    db = await withSchema();
    store = new ProactiveStore(db.pool);
    await seedTrip(db.pool, 't_goa');
  });
  afterAll(async () => {
    await db.drop();
  });

  const make = (packs = fakePacks(goaPack()), readTrip = async (): Promise<Trip> => goaTrip()) =>
    createOpenings({ store, packs, readTrip, now: () => NOW, replan: async (tripId) => { replanned.push(tripId); } });

  it('stores a chat opening and a hush from what the reflex read', async () => {
    const o = make();
    const pack = goaPack();
    await o.onRead(msg({ id: 'm_60', seq: 60, by: 'p_meher', text: 'anyone know when check-in is?' }), sureOpening, pack);
    await o.onRead(msg({ id: 'm_61', seq: 61, by: 'p_kabir', text: '@Go bas karo', mentionsGo: true }), unsureRead(), pack);
    expect((await store.status('t_goa', 'chat:m_60'))?.status).toBe('pending');
    expect((await store.signals('t_goa', '2026-10-06')).hushCount).toBe(1);
  });

  it('reads the trip again for new dates, adds the clash and re-plans', async () => {
    const moved = goaTrip({ dates: { start: '2026-11-13', end: '2026-11-16' } });
    const o = make(fakePacks(goaPack()), async () => moved);
    await o.onEvent(ev(140, 'trip.updated', { by: { kind: 'person', person_id: 'p_rahul' }, changed: ['dates'] }));
    expect((await store.status('t_goa', 'dates_clash:b_villa:2026-11-13:2026-11-16'))?.status).toBe('pending');
    expect(replanned).toContain('t_goa');
  });

  it('ignores events that change nothing it watches', async () => {
    const before = replanned.length;
    await make().onEvent(ev(141, 'reaction.added', { message_id: 'm_60', reaction: { emoji: '👍', person_id: 'p_priya' } }));
    expect(replanned.length).toBe(before);
  });

  it('counts an unprompted post nobody answered as ignored', async () => {
    const c = candidate({ dedupeKey: 'ign:9' });
    await store.add(c);
    const posted = new Date(NOW.getTime() - 7 * 3600_000);
    await store.promote(c, { allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true, localDay: '2026-10-05' }, posted);
    await store.posted('t_goa', 'ign:9', 'm_go_77');
    const pack = goaPack({ messages: [msg({ id: 'm_go_77', by: 'go', sentAt: posted.toISOString() })] });
    expect(await make(fakePacks(pack)).checkIgnored()).toBe(1);
    expect((await store.signals('t_goa', '2026-10-06')).ignoredCount).toBe(1);
    expect(await make(fakePacks(pack)).checkIgnored()).toBe(0);
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the module does not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/brain/src/proactive/openings.ts
// Openings: moments Go might help without being asked, from the chat (the reflex's opening question)
// and from trip changes. Also the two signals that make Go quieter: a hush, and nudges people ignored.
import type { Message, Trip, TripEvent } from '../door/methods.js';
import type { ReflexRead } from '../reflex/reflex.js';
import type { Packs, TripPack } from '../trips/pack.js';
import type { Action, Candidate } from './policy.js';
import type { ProactiveStore } from './store.js';
import { dateClashes } from './timers.js';

export const HUSH_RE =
  /\b(hush|shush|be quiet|keep quiet|shut up|chup( kar| karo| raho| ho ja)?|bas kar(o)?|stop pinging|stop messaging|stop spamming|too many messages)\b/i;
export const CHAT_WAIT_MS = 15_000;
export const CHAT_EXPIRES_MS = 10 * 60_000;
export const IGNORED_AFTER_MS = 6 * 3600_000;
const CHANGE_WAIT_MS = 3_000;
const CHANGE_EXPIRES_MS = 6 * 3600_000;

/** Trip changes that can move a timer or a watch, or open something worth saying. */
export const REPLAN_ON: ReadonlySet<string> = new Set([
  'trip.created', 'trip.updated', 'decision.opened', 'decision.voted', 'decision.closed', 'decision.cancelled',
  'mandate.set', 'mandate.confirmed', 'mandate.declined', 'booking.changed',
]);

export function talksToGo(msg: Message, pack: TripPack): boolean {
  if (msg.mentions_go) return true;
  if (!msg.reply_to) return false;
  return pack.messages.some((m) => m.message_id === msg.reply_to && m.author.kind === 'go');
}

export function isHush(msg: Message, pack: TripPack): boolean {
  return msg.author.kind === 'person' && typeof msg.text === 'string' && talksToGo(msg, pack) && HUSH_RE.test(msg.text);
}

export function chatOpening(msg: Message, read: ReflexRead, now: Date, tripId: string): Candidate | null {
  if (msg.author.kind !== 'person' || msg.withheld || msg.deleted || msg.mentions_go) return null;
  if (!(read.opening.sure && read.opening.value === true)) return null;
  if (read.forGo.sure && read.forGo.value === true) return null;
  return {
    tripId,
    dedupeKey: `chat:${msg.message_id}`,
    source: 'opening',
    topic: 'chat',
    dueAt: new Date(now.getTime() + CHAT_WAIT_MS),
    expiresAt: new Date(now.getTime() + CHAT_EXPIRES_MS),
    importance: 0.6,
    confidence: 0.9,
    urgency: 0.9,
    useful: ['react', 'record', 'message'],
    personIds: [],
    facts: { message_id: msg.message_id, seq: msg.seq },
    simulated: false,
    small: false,
  };
}

export function tripChangeOpenings(ev: TripEvent, trip: Trip, now: Date): Candidate[] {
  const make = (o: { key: string; topic: string; importance: number; urgency: number; useful: Action[]; facts: Record<string, unknown> }): Candidate => ({
    tripId: ev.trip_id,
    dedupeKey: o.key,
    source: 'opening',
    topic: o.topic,
    dueAt: new Date(now.getTime() + CHANGE_WAIT_MS),
    expiresAt: new Date(now.getTime() + CHANGE_EXPIRES_MS),
    importance: o.importance,
    confidence: 1,
    urgency: o.urgency,
    useful: o.useful,
    personIds: [],
    facts: o.facts,
    simulated: false,
    small: false,
  });
  const clashes = (): Candidate[] =>
    dateClashes(trip).map((x) =>
      make({
        key: `dates_clash:${x.booking_id}:${trip.dates?.start ?? ''}:${trip.dates?.end ?? ''}`,
        topic: 'dates_clash',
        importance: 0.9,
        urgency: 0.8,
        useful: ['message'],
        facts: { booking_id: x.booking_id, title: x.title, starts_at: x.starts_at, ends_at: x.ends_at, start: trip.dates?.start ?? null, end: trip.dates?.end ?? null },
      }),
    );

  switch (ev.type) {
    case 'decision.closed': {
      if (ev.data.reason === 'closed_by_go') return [];
      const d = ev.data.decision;
      const winner = d.result_index != null ? (d.options[d.result_index]?.label ?? null) : null;
      return [make({ key: `vote_closed:${d.decision_id}`, topic: 'vote_closed', importance: 0.8, urgency: 0.8, useful: ['message'], facts: { decision_id: d.decision_id, question: d.question, winner } })];
    }
    case 'booking.changed': {
      const b = ev.data.booking;
      if (ev.data.change === 'cancelled' && ev.data.by.kind !== 'go') {
        const by = ev.data.by.kind === 'person' ? ev.data.by.person_id : null;
        return [make({ key: `booking_cancelled:${b.booking_id}`, topic: 'booking_cancelled', importance: 0.8, urgency: 0.8, useful: ['message'], facts: { booking_id: b.booking_id, title: b.title, by } })];
      }
      return ev.data.change === 'added' ? clashes() : [];
    }
    case 'trip.updated':
      return ev.data.changed.includes('dates') ? clashes() : [];
    default:
      return [];
  }
}

/** Did anyone react to, reply to, or talk to Go after an unprompted post? A post of nothing is never ignored. */
export function wasEngaged(pack: TripPack, decidedAt: Date, postedMessageId: string | null, windowMs: number): boolean {
  const from = decidedAt.getTime();
  const until = from + windowMs;
  const goIds = new Set<string>();
  if (postedMessageId) goIds.add(postedMessageId);
  for (const m of pack.messages) {
    const t = Date.parse(m.sent_at);
    if (m.author.kind === 'go' && t >= from && t <= from + 120_000) goIds.add(m.message_id);
  }
  if (goIds.size === 0) return true;
  for (const m of pack.messages) {
    if (goIds.has(m.message_id) && m.reactions.some((r) => r.person_id != null)) return true;
    const t = Date.parse(m.sent_at);
    if (m.author.kind !== 'person' || t < from || t > until) continue;
    if ((m.reply_to && goIds.has(m.reply_to)) || m.mentions_go) return true;
  }
  return false;
}

export interface OpeningsDeps {
  store: ProactiveStore;
  packs: Pick<Packs, 'get'>;
  /** `read_trip` on the socket: `trip.updated` carries no values. */
  readTrip(tripId: string): Promise<Trip>;
  /** Re-plans timers and watches from the trip as it is now. */
  replan(tripId: string, trip: Trip): Promise<void>;
  now: () => Date;
}

export function createOpenings(d: OpeningsDeps) {
  return {
    async onRead(msg: Message, read: ReflexRead, pack: TripPack): Promise<void> {
      const tripId = pack.trip.trip_id;
      if (isHush(msg, pack)) await d.store.hush(tripId, d.now());
      const c = chatOpening(msg, read, d.now(), tripId);
      if (c) await d.store.add(c);
    },

    async onEvent(ev: TripEvent): Promise<void> {
      if (!REPLAN_ON.has(ev.type)) return;
      const trip = ev.type === 'trip.created'
        ? ev.data.trip
        : ev.type === 'trip.updated' ? await d.readTrip(ev.trip_id) : (await d.packs.get(ev.trip_id)).trip;
      for (const c of tripChangeOpenings(ev, trip, d.now())) await d.store.add(c);
      await d.replan(ev.trip_id, trip);
    },

    async checkIgnored(): Promise<number> {
      const now = d.now();
      let ignored = 0;
      for (const row of await d.store.toCheckForIgnored(new Date(now.getTime() - IGNORED_AFTER_MS))) {
        const pack = await d.packs.get(row.tripId);
        if (!wasEngaged(pack, row.decidedAt, row.postedMessageId, IGNORED_AFTER_MS)) {
          await d.store.ignored(row.tripId, now);
          ignored += 1;
        }
        await d.store.ignoreChecked(row.tripId, row.dedupeKey, now);
      }
      return ignored;
    },
  };
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/proactive/openings.ts apps/brain/src/proactive/openings.test.ts
git commit -m "feat(proactive): openings from the chat and trip changes; a hush or an ignored nudge makes Go quieter

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `openings.test.ts` passes; earlier tests stay green.

### Task 7: Watches: what to watch, how to read it, which change matters

**Files:**
- Create: `apps/brain/src/db/migrations/5100_watches.sql`
- Create: `apps/brain/src/watches/port.ts`
- Create: `apps/brain/src/watches/diff.ts`
- Create: `apps/brain/src/watches/plan.ts`
- Test: `apps/brain/src/watches/watches.test.ts`

**Interfaces:**
- Consumes: `Action` (Task 1); `Travel` (P4 `travel/travel.ts`, only `status`); `Trip` (P1); `withSchema()` (P1).
- Produces:
  - `port.ts`: `WATCH_KINDS = ['flight_status', 'fare', 'availability'] as const`; `type WatchKind`; `Reading` (zod discriminated union on `kind`: `flight_status { checkedAt, status, departAt, arriveAt, delayMinutes }`, `fare { checkedAt, priceMinor, currency }`, `availability { checkedAt, available, left: number | null }`); `interface StatusPort { read(kind: WatchKind, query: Record<string, unknown>): Promise<Reading> }`; `travelStatusPort(travel: Pick<Travel, 'status'>): StatusPort`.
  - `diff.ts`: `interface WatchInfo { watchId; kind: WatchKind; label; query: Record<string, unknown>; hasNotice: boolean; hasPeople: boolean }`; `interface WatchChange { changeKey; importance; confidence; urgency; small; useful: Action[]; facts: Record<string, unknown> }`; `diffReading(w, before: Reading | null, after: Reading, now: Date): WatchChange | null`.
  - `plan.ts`: `interface WatchPlan { watchId; tripId; kind; query; personIds; label; startAt: Date; endsAt: Date }`; `planWatches(trip, now): WatchPlan[]`; `syncWatches(pool, trip, now): Promise<void>`; `noteWatchNotice(pool, watchId, cardId): Promise<void>`.

The watches a trip gets (spec §8 "The world", §12 "Status"):
- **Flight status** for each confirmed flight booking with a carrier code and number: checks start 24 h before departure and stop an hour after arrival. A change matters when the delay crosses into a new 15-minute step at 30 minutes or more, or the flight is cancelled; once Go posted a notice, a later change may update it in place, and "back on time" only ever updates it.
- **Fare** for each priced option of an open vote, against the price it was shortlisted at: 10% or more is worth a message; 5 to 10% is a small thing that waits to be batched; under 5% is nothing.
- **Availability** for each stay option of an open vote: gone, or 2 or fewer left.

Each change has a change key (`<watch_id>:delay:120`, `<watch_id>:down:<price bucket>`), which is the candidate's dedupe key, so the same change is never nudged twice.

`port.ts` is the only file that touches P4's `StatusQuery` and `StatusResult`. It sends `{ kind: 'flight' | 'fare' | 'availability', ...query }` and reads the answer through `Reading`, so a shape mismatch fails loudly in one place (see the interface notes for the shapes P6 expects).

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/watches/watches.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import { goaTrip } from '../proactive/fakes.js';
import { diffReading, type WatchInfo } from './diff.js';
import { noteWatchNotice, planWatches, syncWatches } from './plan.js';
import { travelStatusPort, type Reading } from './port.js';

const NOW = new Date('2026-11-06T07:00:00Z'); // travel day, under 6 hours before the 12:45Z departure
const flight = (delayMinutes: number, status: 'scheduled' | 'delayed' | 'cancelled' = delayMinutes > 0 ? 'delayed' : 'scheduled'): Reading => ({
  kind: 'flight_status', checkedAt: NOW.toISOString(), status, departAt: '2026-11-06T18:15:00+05:30', arriveAt: '2026-11-06T20:45:00+05:30', delayMinutes,
});
const info = (over: Partial<WatchInfo> = {}): WatchInfo => ({ watchId: 'flight:t_goa:b_flight', kind: 'flight_status', label: 'IndiGo 6E 2134', query: {}, hasNotice: false, hasPeople: true, ...over });

describe('travelStatusPort', () => {
  it('asks P4 for the kind and reads the answer through one schema', async () => {
    const asked: unknown[] = [];
    const travel = {
      status: async (q: unknown) => {
        asked.push(q);
        return { kind: 'flight', checkedAt: NOW.toISOString(), status: 'delayed', departAt: '2026-11-06T18:15:00+05:30', arriveAt: '2026-11-06T22:45:00+05:30', delayMinutes: 120 };
      },
    };
    const port = travelStatusPort(travel as never);
    const r = await port.read('flight_status', { carrierCode: '6E', number: '2134', date: '2026-11-06' });
    expect(asked[0]).toEqual({ kind: 'flight', carrierCode: '6E', number: '2134', date: '2026-11-06' });
    expect(r).toMatchObject({ kind: 'flight_status', delayMinutes: 120 });
  });

  it('fails loudly when P4 answers a different shape', async () => {
    const port = travelStatusPort({ status: async () => ({ kind: 'flight', delay: 'two hours' }) } as never);
    await expect(port.read('flight_status', {})).rejects.toThrow();
  });
});

describe('diffReading: flights', () => {
  it('says nothing about a flight on time', () => {
    expect(diffReading(info(), null, flight(0), NOW)).toBeNull();
    expect(diffReading(info(), flight(0), flight(10), NOW)).toBeNull();
  });

  it('flags a delay of 30 minutes or more, once per 15-minute step', () => {
    const c = diffReading(info(), flight(0), flight(120), NOW);
    expect(c).toMatchObject({ changeKey: 'flight:t_goa:b_flight:delay:120', importance: 0.9, urgency: 0.9, useful: ['pin', 'message'] });
    expect(diffReading(info(), flight(120), flight(125), NOW)).toBeNull();
    expect(diffReading(info(), flight(120), flight(135), NOW)?.changeKey).toBe('flight:t_goa:b_flight:delay:135');
  });

  it('updates the earlier notice first when there is one, and only updates it when back on time', () => {
    expect(diffReading(info({ hasNotice: true }), flight(60), flight(120), NOW)?.useful).toEqual(['update_card', 'pin', 'message']);
    expect(diffReading(info({ hasNotice: true }), flight(120), flight(0), NOW)?.useful).toEqual(['update_card']);
    expect(diffReading(info({ hasNotice: false }), flight(120), flight(0), NOW)).toBeNull();
  });

  it('flags a cancellation once', () => {
    expect(diffReading(info(), flight(0), flight(0, 'cancelled'), NOW)).toMatchObject({ changeKey: 'flight:t_goa:b_flight:cancelled', importance: 1 });
    expect(diffReading(info(), flight(0, 'cancelled'), flight(0, 'cancelled'), NOW)).toBeNull();
  });
});

describe('diffReading: fares and availability', () => {
  const fareInfo = info({ watchId: 'fare:t_goa:d_villa:0', kind: 'fare', label: 'Villa Sol', query: { optionRef: 'ixigo:stay:villa-sol-anjuna', priceMinor: 5420000, currency: 'INR' }, hasPeople: false });
  const fare = (priceMinor: number): Reading => ({ kind: 'fare', checkedAt: NOW.toISOString(), priceMinor, currency: 'INR' });
  it('measures against the shortlisted price', () => {
    expect(diffReading(fareInfo, null, fare(5500000), NOW)).toBeNull(); // +1.5%
    expect(diffReading(fareInfo, null, fare(5100000), NOW)).toMatchObject({ small: true, useful: ['message'] }); // -5.9%
    expect(diffReading(fareInfo, null, fare(4800000), NOW)).toMatchObject({ small: false, importance: 0.7, facts: { beforeMinor: 5420000, priceMinor: 4800000, pct: -11 } });
  });
  const availInfo = info({ watchId: 'avail:t_goa:d_villa:0', kind: 'availability', label: 'Villa Sol', hasPeople: false });
  const avail = (available: boolean, left: number | null): Reading => ({ kind: 'availability', checkedAt: NOW.toISOString(), available, left });
  it('flags a stay that is going or gone', () => {
    expect(diffReading(availInfo, avail(true, 5), avail(true, 2), NOW)?.changeKey).toBe('avail:t_goa:d_villa:0:left:2');
    expect(diffReading(availInfo, avail(true, 2), avail(true, 1), NOW)).toBeNull();
    expect(diffReading(availInfo, avail(true, 1), avail(false, 0), NOW)?.changeKey).toBe('avail:t_goa:d_villa:0:gone');
  });
});

describe('planWatches and syncWatches', () => {
  it('watches the booked flight and the open vote options', () => {
    const plans = planWatches(goaTrip(), new Date('2026-10-06T06:30:00Z'));
    const ids = plans.map((p) => p.watchId);
    expect(ids).toEqual([
      'flight:t_goa:b_flight',
      'fare:t_goa:d_villa:0', 'avail:t_goa:d_villa:0',
      'fare:t_goa:d_villa:1', 'avail:t_goa:d_villa:1',
    ]);
    const f = plans[0]!;
    expect(f).toMatchObject({ kind: 'flight_status', personIds: ['p_rahul', 'p_priya', 'p_kabir'], label: 'IndiGo 6E 2134', query: { carrierCode: '6E', number: '2134', date: '2026-11-06' } });
    expect(f.startAt.toISOString()).toBe('2026-11-05T12:45:00.000Z');
    expect(f.endsAt.toISOString()).toBe('2026-11-06T16:15:00.000Z');
  });

  let db: Awaited<ReturnType<typeof withSchema>>;
  beforeAll(async () => {
    db = await withSchema();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('keeps the table in step with the trip, safe to repeat', async () => {
    const now = new Date('2026-10-06T06:30:00Z');
    await syncWatches(db.pool, goaTrip(), now);
    await syncWatches(db.pool, goaTrip(), now);
    const active = await db.pool.query(`select watch_id from watches where active order by watch_id`);
    expect(active.rows).toHaveLength(5);

    const base = goaTrip();
    await syncWatches(db.pool, goaTrip({ decisions: [{ ...base.decisions[0]!, status: 'closed' }] }), now);
    const left = await db.pool.query<{ watch_id: string }>(`select watch_id from watches where active`);
    expect(left.rows.map((r) => r.watch_id)).toEqual(['flight:t_goa:b_flight']);

    await noteWatchNotice(db.pool, 'flight:t_goa:b_flight', 'c_notice_1');
    const n = await db.pool.query<{ notice_card_id: string }>(`select notice_card_id from watches where watch_id = 'flight:t_goa:b_flight'`);
    expect(n.rows[0]?.notice_card_id).toBe('c_notice_1');
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the modules do not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```sql
-- apps/brain/src/db/migrations/5100_watches.sql
-- Cheap scheduled checks (flight status, fares, availability) for things a trip has booked or shortlisted.
create table watches (
  watch_id text primary key,
  trip_id text not null,
  kind text not null check (kind in ('flight_status', 'fare', 'availability')),
  query jsonb not null,
  person_ids text[] not null default '{}',
  label text not null,
  last_reading jsonb,
  last_change_key text,
  next_check_at timestamptz not null,
  ends_at timestamptz not null,
  active boolean not null default true,
  errors integer not null default 0,
  last_error text,
  notice_card_id text,
  created_at timestamptz not null default now()
);
create index watches_due on watches (next_check_at) where active;
create index watches_trip on watches (trip_id);
```

```ts
// apps/brain/src/watches/port.ts
// One reading of something Go watches, and the adapter over the travel layer's status call. This is the
// only file that builds a P4 StatusQuery or reads a StatusResult.
import { z } from 'zod';
import type { Travel } from '../travel/travel.js';

export const WATCH_KINDS = ['flight_status', 'fare', 'availability'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

const When = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'a date');

export const Reading = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('flight_status'),
    checkedAt: When,
    status: z.enum(['scheduled', 'delayed', 'cancelled', 'departed', 'landed']),
    departAt: When,
    arriveAt: When,
    delayMinutes: z.int().min(0),
  }),
  z.object({ kind: z.literal('fare'), checkedAt: When, priceMinor: z.int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }),
  z.object({ kind: z.literal('availability'), checkedAt: When, available: z.boolean(), left: z.int().min(0).nullable() }),
]);
export type Reading = z.infer<typeof Reading>;

export interface StatusPort {
  read(kind: WatchKind, query: Record<string, unknown>): Promise<Reading>;
}

const P4_KIND: Readonly<Record<WatchKind, string>> = { flight_status: 'flight', fare: 'fare', availability: 'availability' };

export function travelStatusPort(travel: Pick<Travel, 'status'>): StatusPort {
  return {
    async read(kind, query) {
      // P4 owns StatusQuery; P6 sends its kind plus the watch's stored query (see the interface notes).
      const q = { kind: P4_KIND[kind], ...query } as unknown as Parameters<Travel['status']>[0];
      const result: unknown = await travel.status(q);
      return Reading.parse({ ...(result as Record<string, unknown>), kind });
    },
  };
}
```

```ts
// apps/brain/src/watches/diff.ts
// Which change between two readings is worth a nudge. Each change has a key: the same change is nudged once.
import type { Action } from '../proactive/policy.js';
import type { Reading, WatchKind } from './port.js';

export interface WatchInfo {
  watchId: string;
  kind: WatchKind;
  label: string;
  query: Record<string, unknown>;
  /** Go already posted a notice for this watch, so a change can update it in place. */
  hasNotice: boolean;
  /** The watch concerns particular people (a flight's travellers), so a pin can reach just them. */
  hasPeople: boolean;
}

export interface WatchChange {
  changeKey: string;
  importance: number;
  confidence: number;
  urgency: number;
  small: boolean;
  useful: Action[];
  facts: Record<string, unknown>;
}

const DELAY_STEP = 15;
const DELAY_FLAG = 30;

type Flight = Extract<Reading, { kind: 'flight_status' }>;
type Fare = Extract<Reading, { kind: 'fare' }>;
type Availability = Extract<Reading, { kind: 'availability' }>;

function flightChange(w: WatchInfo, before: Flight | null, after: Flight, now: Date): WatchChange | null {
  const hoursToGo = (Date.parse(after.departAt) - now.getTime()) / 3600_000;
  const urgency = hoursToGo <= 6 ? 0.9 : hoursToGo <= 24 ? 0.7 : 0.4;
  const posts: Action[] = w.hasPeople ? ['pin', 'message'] : ['message'];
  const facts: Record<string, unknown> = {
    status: after.status,
    delayMinutes: after.delayMinutes,
    departAt: after.departAt,
    arriveAt: after.arriveAt,
    ...(before ? { beforeDelayMinutes: before.delayMinutes, beforeStatus: before.status } : {}),
  };
  if (after.status === 'cancelled') {
    if (before?.status === 'cancelled') return null;
    return { changeKey: `${w.watchId}:cancelled`, importance: 1, confidence: 0.95, urgency, small: false, useful: posts, facts };
  }
  const step = Math.floor(after.delayMinutes / DELAY_STEP) * DELAY_STEP;
  const was = before ? Math.floor(before.delayMinutes / DELAY_STEP) * DELAY_STEP : 0;
  if (step >= DELAY_FLAG && step !== was) {
    const useful: Action[] = w.hasNotice ? ['update_card', ...posts] : posts;
    return { changeKey: `${w.watchId}:delay:${step}`, importance: step >= 60 ? 0.9 : 0.7, confidence: 0.95, urgency, small: false, useful, facts };
  }
  if (step < DELAY_FLAG && was >= DELAY_FLAG && w.hasNotice) {
    return { changeKey: `${w.watchId}:ontime:${after.departAt}`, importance: 0.6, confidence: 0.95, urgency, small: false, useful: ['update_card'], facts };
  }
  return null;
}

function fareChange(w: WatchInfo, before: Fare | null, after: Fare): WatchChange | null {
  const shortlisted = typeof w.query.priceMinor === 'number' ? w.query.priceMinor : null;
  const base = shortlisted ?? before?.priceMinor ?? null;
  if (base === null || base <= 0) return null;
  const pct = (after.priceMinor - base) / base;
  if (Math.abs(pct) < 0.05) return null;
  const big = Math.abs(pct) >= 0.1;
  return {
    changeKey: `${w.watchId}:${pct < 0 ? 'down' : 'up'}:${Math.round(after.priceMinor / 50_000)}`,
    importance: big ? 0.7 : 0.5,
    confidence: 0.9,
    urgency: 0.8,
    small: !big,
    useful: ['message'],
    facts: { priceMinor: after.priceMinor, beforeMinor: base, currency: after.currency, pct: Math.round(pct * 100) },
  };
}

function availabilityChange(w: WatchInfo, before: Availability | null, after: Availability): WatchChange | null {
  if (!after.available && (before === null || before.available)) {
    return { changeKey: `${w.watchId}:gone`, importance: 0.8, confidence: 0.9, urgency: 0.9, small: false, useful: ['message'], facts: { available: false } };
  }
  const fewNow = after.available && after.left !== null && after.left <= 2;
  const fewBefore = before !== null && before.left !== null && before.left <= 2;
  if (fewNow && !fewBefore) {
    return { changeKey: `${w.watchId}:left:${after.left}`, importance: 0.6, confidence: 0.9, urgency: 0.9, small: false, useful: ['message'], facts: { available: true, left: after.left } };
  }
  return null;
}

export function diffReading(w: WatchInfo, before: Reading | null, after: Reading, now: Date): WatchChange | null {
  switch (after.kind) {
    case 'flight_status':
      return flightChange(w, before?.kind === 'flight_status' ? before : null, after, now);
    case 'fare':
      return fareChange(w, before?.kind === 'fare' ? before : null, after);
    case 'availability':
      return availabilityChange(w, before?.kind === 'availability' ? before : null, after);
  }
}
```

```ts
// apps/brain/src/watches/plan.ts
// Which watches a trip needs right now, kept in step with the trip on every change (level-triggered).
import type pg from 'pg';
import type { Trip } from '../door/methods.js';
import type { WatchKind } from './port.js';

export interface WatchPlan {
  watchId: string;
  tripId: string;
  kind: WatchKind;
  query: Record<string, unknown>;
  personIds: string[];
  label: string;
  startAt: Date;
  endsAt: Date;
}

const H = 3600_000;

export function planWatches(trip: Trip, now: Date): WatchPlan[] {
  const out: WatchPlan[] = [];
  const t = now.getTime();
  for (const b of trip.bookings) {
    const j = b.journey;
    if (b.status !== 'confirmed' || b.kind !== 'flight' || !j || !j.carrier_code || !j.number) continue;
    const depart = Date.parse(j.depart_at);
    const arrive = Date.parse(j.arrive_at);
    if (arrive + H <= t) continue;
    out.push({
      watchId: `flight:${trip.trip_id}:${b.booking_id}`,
      tripId: trip.trip_id,
      kind: 'flight_status',
      query: { carrierCode: j.carrier_code, number: j.number, date: j.depart_at.slice(0, 10) },
      personIds: b.for_person_ids,
      label: `${j.carrier_name ? `${j.carrier_name} ` : ''}${j.carrier_code} ${j.number}`,
      startAt: new Date(Math.max(t, depart - 24 * H)),
      endsAt: new Date(arrive + H),
    });
  }
  for (const d of trip.decisions) {
    if (d.status !== 'open') continue;
    const endsAt = d.closes_at ? new Date(Date.parse(d.closes_at)) : new Date(t + 72 * H);
    if (endsAt.getTime() <= t) continue;
    d.options.forEach((o, i) => {
      if (!o.option_ref) return;
      if (o.price_minor != null && o.currency) {
        out.push({
          watchId: `fare:${trip.trip_id}:${d.decision_id}:${i}`, tripId: trip.trip_id, kind: 'fare',
          query: { optionRef: o.option_ref, priceMinor: o.price_minor, currency: o.currency },
          personIds: [], label: o.label, startAt: now, endsAt,
        });
      }
      if (o.option_ref.startsWith('ixigo:stay:')) {
        out.push({
          watchId: `avail:${trip.trip_id}:${d.decision_id}:${i}`, tripId: trip.trip_id, kind: 'availability',
          query: { optionRef: o.option_ref }, personIds: [], label: o.label, startAt: now, endsAt,
        });
      }
    });
  }
  return out;
}

export async function syncWatches(pool: pg.Pool, trip: Trip, now: Date): Promise<void> {
  const plans = planWatches(trip, now);
  for (const p of plans) {
    await pool.query(
      `insert into watches (watch_id, trip_id, kind, query, person_ids, label, next_check_at, ends_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (watch_id) do update set query = excluded.query, person_ids = excluded.person_ids,
         label = excluded.label, ends_at = excluded.ends_at, active = true`,
      [p.watchId, p.tripId, p.kind, JSON.stringify(p.query), p.personIds, p.label, p.startAt, p.endsAt],
    );
  }
  await pool.query(
    `update watches set active = false where trip_id = $1 and active and not (watch_id = any($2::text[]))`,
    [trip.trip_id, plans.map((p) => p.watchId)],
  );
}

export async function noteWatchNotice(pool: pg.Pool, watchId: string, cardId: string): Promise<void> {
  await pool.query(`update watches set notice_card_id = $2 where watch_id = $1`, [watchId, cardId]);
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/db/migrations/5100_watches.sql apps/brain/src/watches/port.ts apps/brain/src/watches/diff.ts apps/brain/src/watches/plan.ts apps/brain/src/watches/watches.test.ts
git commit -m "feat(watches): what a trip watches (flights, fares, stays) and which change is worth a nudge

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `watches.test.ts` passes; earlier tests stay green.

### Task 8: The watch runner, the demo's "fire a watch", and wiring proactive into Go

**Files:**
- Create: `apps/brain/src/watches/runner.ts`
- Create: `apps/brain/src/watches/admin.ts`
- Create: `apps/brain/src/proactive/register.ts`
- Modify: `apps/brain/src/main.ts` (one import and one `await registerProactive(brain)` line after `registerMoney`)
- Test: `apps/brain/src/watches/runner.test.ts`
- Test: `apps/brain/src/proactive/register.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 7; `Brain`, `RegisterLane` (P1); `brain.travel?.status` (P4); `brain.door.link.request('read_trip')` (P1); `brain.env.ADMIN_TOKEN` (P7's variable, declared by P1).
- Produces:
  - `runner.ts`: `nextCheckIn(kind, reading, now): number` (ms); `backoffMs(errors): number`; `interface WatchRunnerDeps { pool; port: StatusPort | null; store: ProactiveStore; now; log }`; `createWatchRunner(deps): { tick(): Promise<number> }` (returns how many changes became candidates).
  - `admin.ts`: `FireWatchBody` (zod); `interface FireDeps { adminToken: string | undefined; store: ProactiveStore; now: () => Date; promote: () => Promise<number> }`; `registerFireRoute(app: FastifyInstance, deps: FireDeps): void` (`POST /admin/watch/fire`).
  - `register.ts`: `PROMOTE_EVERY_MS = 15_000`, `WATCH_EVERY_MS = 30_000`, `SWEEP_EVERY_MS = 600_000`, `ACTIVE_TRIP_DAYS = 90`; `interface ProactiveHandles { store; promote(): Promise<number>; checkWatches(): Promise<number>; sweep(): Promise<void>; stop(): void }`; `startProactive(brain, opts?: { intervals?: boolean; port?: StatusPort | null }): Promise<ProactiveHandles>`; `registerProactive: RegisterLane`.

Decision: watches are registered by `registerProactive` (the master's boot order has `registerProactive` and `registerCalls`, no `registerWatches`, and watches only feed the proactive candidates). The code stays in `watches/`.

The demo's simulated watch (master §1 3:40 and §9): P7's admin page calls `POST /admin/watch/fire` with `Authorization: Bearer <ADMIN_TOKEN>` and a body such as `{ "trip_id": "t_goa", "label": "IndiGo 6E 2134", "person_ids": ["p_arjun"], "delay_minutes": 120, "arrive_at": "2026-11-06T22:45:00+05:30", "note": "Arjun's airport cab is booked for 9 pm" }`. It adds a `watch` candidate with `simulated: true` and runs the promoter at once, so the nudge reaches the desk within a second; it goes through the same bar as any watch. `reset_budget: true` (for rehearsals) first stops today's earlier unprompted posts counting, which also clears "two in a row".

- [ ] **Step 1: Write the failing tests**

```ts
// apps/brain/src/watches/runner.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import { goaTrip, seedTrip } from '../proactive/fakes.js';
import { ProactiveStore } from '../proactive/store.js';
import { syncWatches } from './plan.js';
import type { Reading } from './port.js';
import { backoffMs, createWatchRunner, nextCheckIn } from './runner.js';

const START = new Date('2026-11-06T07:00:00Z'); // 5 h 45 min before the flight leaves
const flight = (delayMinutes: number): Reading => ({
  kind: 'flight_status', checkedAt: START.toISOString(), status: delayMinutes > 0 ? 'delayed' : 'scheduled',
  departAt: '2026-11-06T18:15:00+05:30', arriveAt: '2026-11-06T20:45:00+05:30', delayMinutes,
});

let db: Awaited<ReturnType<typeof withSchema>>;
let store: ProactiveStore;
beforeAll(async () => {
  db = await withSchema();
  store = new ProactiveStore(db.pool);
  await seedTrip(db.pool, 't_goa');
  await syncWatches(db.pool, goaTrip(), START); // the vote has closed by then: only the flight is watched
});
afterAll(async () => {
  await db.drop();
});

describe('timing', () => {
  it('checks a flight more often as it gets close', () => {
    expect(nextCheckIn('flight_status', flight(0), START)).toBe(20 * 60_000);
    expect(nextCheckIn('flight_status', flight(0), new Date('2026-11-06T10:00:00Z'))).toBe(5 * 60_000);
    expect(nextCheckIn('fare', { kind: 'fare', checkedAt: START.toISOString(), priceMinor: 1, currency: 'INR' }, START)).toBe(360 * 60_000);
    expect(backoffMs(1)).toBe(2 * 60_000);
    expect(backoffMs(10)).toBe(60 * 60_000);
  });
});

describe('createWatchRunner', () => {
  it('turns a new delay into one candidate, never twice, and backs off on errors', async () => {
    let now = START;
    const readings: Array<Reading | Error> = [flight(0), flight(120), flight(120), new Error('ixigo is down')];
    const port = {
      read: async (): Promise<Reading> => {
        const next = readings.shift();
        if (!next || next instanceof Error) throw next ?? new Error('no reading');
        return next;
      },
    };
    const runner = createWatchRunner({ pool: db.pool, port, store, now: () => now, log: { warn: () => {} } });

    expect(await runner.tick()).toBe(0); // on time: nothing
    now = new Date(START.getTime() + 20 * 60_000);
    expect(await runner.tick()).toBe(1); // 2 h late
    const c = await store.status('t_goa', 'flight:t_goa:b_flight:delay:120');
    expect(c?.status).toBe('pending');
    const facts = await db.pool.query<{ facts: Record<string, unknown>; person_ids: string[]; useful: string[] }>(
      `select facts, person_ids, useful from proactive_candidates where dedupe_key = 'flight:t_goa:b_flight:delay:120'`,
    );
    expect(facts.rows[0]).toMatchObject({ person_ids: ['p_rahul', 'p_priya', 'p_kabir'], useful: ['pin', 'message'], facts: { watchId: 'flight:t_goa:b_flight', label: 'IndiGo 6E 2134', delayMinutes: 120 } });

    now = new Date(now.getTime() + 20 * 60_000);
    expect(await runner.tick()).toBe(0); // the same delay again: nothing new

    now = new Date(now.getTime() + 20 * 60_000);
    expect(await runner.tick()).toBe(0); // an error
    const w = await db.pool.query<{ errors: number; last_error: string; next_check_at: Date }>(`select errors, last_error, next_check_at from watches where watch_id = 'flight:t_goa:b_flight'`);
    expect(w.rows[0]).toMatchObject({ errors: 1, last_error: 'ixigo is down' });
    expect(w.rows[0]?.next_check_at.toISOString()).toBe(new Date(now.getTime() + 2 * 60_000).toISOString());
  });

  it('stops a watch whose time is over, and does nothing without a travel layer', async () => {
    const late = new Date('2026-11-07T00:00:00Z');
    await db.pool.query(`update watches set next_check_at = $1 where watch_id = 'flight:t_goa:b_flight'`, [late]);
    const runner = createWatchRunner({ pool: db.pool, port: { read: async () => flight(0) }, store, now: () => late, log: { warn: () => {} } });
    await runner.tick();
    const w = await db.pool.query<{ active: boolean }>(`select active from watches where watch_id = 'flight:t_goa:b_flight'`);
    expect(w.rows[0]?.active).toBe(false);
    expect(await createWatchRunner({ pool: db.pool, port: null, store, now: () => late, log: { warn: () => {} } }).tick()).toBe(0);
  });
});
```

```ts
// apps/brain/src/proactive/register.test.ts
import { Event } from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import { fakeBrain, goaPack, manualTime, seedTrip, turnCtx } from './fakes.js';
import { proactiveOf } from './payload.js';
import { startProactive } from './register.js';

const TOKEN = 'admin-test-token';
const fire = {
  trip_id: 't_goa',
  label: 'IndiGo 6E 2134',
  person_ids: ['p_arjun'],
  delay_minutes: 120,
  arrive_at: '2026-11-06T22:45:00+05:30',
  note: "Arjun's airport cab is booked for 9 pm",
};

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
  await seedTrip(db.pool, 't_goa');
});
afterAll(async () => {
  await db.drop();
});

describe('startProactive', () => {
  it('registers its hooks, wake renderers, the openings block and the notice tools', async () => {
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now, env: { ADMIN_TOKEN: TOKEN } });
    const h = await startProactive(brain, { intervals: false, port: null });
    expect(reg.tools.map((t) => t.name)).toEqual(['post_notice', 'update_notice']);
    expect([...reg.wakes.keys()]).toEqual(['timer', 'watch', 'opening']);
    expect(reg.nows.map((n) => n.name)).toEqual(['openings']);
    expect(reg.onRead).toHaveLength(1);
    expect(reg.onEvent).toHaveLength(1);
    h.stop();
  });

  it('plays the 3:40 demo beat: a simulated delay pinned to Arjun, labelled, within one pass', async () => {
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain, app, reg, desk, link } = fakeBrain({ pool: db.pool, now: time.now, env: { ADMIN_TOKEN: TOKEN } });
    await startProactive(brain, { intervals: false, port: null });

    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', payload: fire })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: { authorization: 'Bearer nope' }, payload: fire })).statusCode).toBe(401);
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { trip_id: 't_goa' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...fire, trip_id: 't_nowhere' } })).statusCode).toBe(404);

    const res = await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: fire });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, promoted: 1 });

    const item = desk.items.at(-1)!;
    expect(item.kind).toBe('watch');
    expect(proactiveOf(item)).toMatchObject({ allowed: ['pin'], forPersonIds: ['p_arjun'], candidate: { simulated: true } });
    const wakeText = reg.wakes.get('watch')!(item, goaPack());
    expect(wakeText).toContain('Simulated for the demo');
    expect(wakeText).toContain('running 120 minutes late');

    const post = reg.tools.find((t) => t.name === 'post_notice')!;
    await post.run(post.input.parse({ tone: 'heads_up', title: 'Your flight is 2 hours late', body: 'You now land at 10:45 pm, but your cab is at 9. Want me to move it to 11?' }), turnCtx({ link, pack: goaPack(), wake: [item] }));
    const card = link.of('post_message').at(-1)?.card as Record<string, unknown>;
    expect(card).toMatchObject({ kind: 'notice', for_person_ids: ['p_arjun'], source: { name: 'Simulated for the demo' } });

    // A second fire straight after is "two in a row": it waits. A rehearsal resets the budget first.
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: fire })).json()).toMatchObject({ promoted: 0 });
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...fire, reset_budget: true } })).json()).toMatchObject({ promoted: 1 });
  });

  it('plans timers and watches when a trip is created, and the sweep re-plans them', async () => {
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now });
    const h = await startProactive(brain, { intervals: false, port: null });
    const created = Event.parse({ event_id: 'ev_1', trip_id: 't_goa', seq: 1, occurred_at: '2026-10-06T06:30:00Z', type: 'trip.created', data: { trip: goaPack().trip } });
    await reg.onEvent[0]!(created);
    const timers = await db.pool.query(`select dedupe_key from proactive_candidates where trip_id = 't_goa' and source = 'timer' and status = 'pending'`);
    expect(timers.rows.map((r: { dedupe_key: string }) => r.dedupe_key)).toContain('travel_day:2026-11-06');
    const watches = await db.pool.query(`select watch_id from watches where trip_id = 't_goa' and active`);
    expect(watches.rows.length).toBeGreaterThan(0);
    await expect(h.sweep()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Push the tests and see them fail**

Red is certain: the modules do not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/brain/src/watches/runner.ts
// Scheduled cheap checks. Each due watch is read once, compared with its last reading, and a change worth
// a nudge becomes a proactive candidate keyed by the change, so the same change is never nudged twice.
import type pg from 'pg';
import type { Candidate } from '../proactive/policy.js';
import type { ProactiveStore } from '../proactive/store.js';
import { diffReading, type WatchChange } from './diff.js';
import { Reading, type StatusPort, type WatchKind } from './port.js';

type WatchRow = {
  watch_id: string;
  trip_id: string;
  kind: WatchKind;
  query: Record<string, unknown>;
  person_ids: string[];
  label: string;
  last_reading: unknown;
  last_change_key: string | null;
  ends_at: Date;
  errors: number;
  notice_card_id: string | null;
};

const MIN = 60_000;

export function nextCheckIn(kind: WatchKind, reading: Reading, now: Date): number {
  if (reading.kind === 'flight_status') {
    const hours = (Date.parse(reading.departAt) - now.getTime()) / 3600_000;
    if (hours <= 3) return 5 * MIN;
    if (hours <= 24) return 20 * MIN;
    return 120 * MIN;
  }
  return kind === 'fare' ? 360 * MIN : 180 * MIN;
}

export function backoffMs(errors: number): number {
  return Math.min(60, 2 ** errors) * MIN;
}

function toCandidate(w: WatchRow, change: WatchChange, reading: Reading, now: Date): Candidate {
  return {
    tripId: w.trip_id,
    dedupeKey: change.changeKey,
    source: 'watch',
    topic: w.kind,
    dueAt: now,
    expiresAt: w.ends_at,
    importance: change.importance,
    confidence: change.confidence,
    urgency: change.urgency,
    useful: change.useful,
    personIds: w.person_ids,
    facts: {
      ...change.facts,
      watchId: w.watch_id,
      label: w.label,
      checkedAt: reading.checkedAt,
      ...(w.notice_card_id ? { noticeCardId: w.notice_card_id } : {}),
    },
    simulated: false,
    small: change.small,
  };
}

export interface WatchRunnerDeps {
  pool: pg.Pool;
  port: StatusPort | null;
  store: ProactiveStore;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
}

export function createWatchRunner(d: WatchRunnerDeps): { tick(): Promise<number> } {
  let running: Promise<number> | null = null;

  async function once(): Promise<number> {
    const port = d.port;
    if (!port) return 0;
    const now = d.now();
    const due = await d.pool.query<WatchRow>(
      `select watch_id, trip_id, kind, query, person_ids, label, last_reading, last_change_key, ends_at, errors, notice_card_id
       from watches where active and next_check_at <= $1 order by next_check_at limit 20`,
      [now],
    );
    let changes = 0;
    for (const w of due.rows) {
      if (now.getTime() >= w.ends_at.getTime()) {
        await d.pool.query(`update watches set active = false where watch_id = $1`, [w.watch_id]);
        continue;
      }
      let reading: Reading;
      try {
        reading = await port.read(w.kind, w.query);
      } catch (err) {
        const errors = w.errors + 1;
        d.log.warn({ err, watchId: w.watch_id }, 'watches: a check failed; backing off');
        await d.pool.query(
          `update watches set errors = $2, last_error = $3, next_check_at = $4 where watch_id = $1`,
          [w.watch_id, errors, (err instanceof Error ? err.message : String(err)).slice(0, 300), new Date(now.getTime() + backoffMs(errors))],
        );
        continue;
      }
      const before = w.last_reading ? Reading.safeParse(w.last_reading) : null;
      const change = diffReading(
        { watchId: w.watch_id, kind: w.kind, label: w.label, query: w.query, hasNotice: w.notice_card_id !== null, hasPeople: w.person_ids.length > 0 },
        before?.success ? before.data : null,
        reading,
        now,
      );
      let lastKey = w.last_change_key;
      if (change && change.changeKey !== w.last_change_key) {
        if ((await d.store.add(toCandidate(w, change, reading, now))) === 'added') changes += 1;
        lastKey = change.changeKey;
      }
      await d.pool.query(
        `update watches set last_reading = $2, last_change_key = $3, errors = 0, last_error = null, next_check_at = $4 where watch_id = $1`,
        [w.watch_id, JSON.stringify(reading), lastKey, new Date(now.getTime() + nextCheckIn(w.kind, reading, now))],
      );
    }
    return changes;
  }

  return {
    tick(): Promise<number> {
      if (!running) running = once().finally(() => { running = null; });
      return running;
    },
  };
}
```

```ts
// apps/brain/src/watches/admin.ts
// POST /admin/watch/fire: the demo's simulated watch. It goes through the same bar as a real one, and every
// card Go posts from it says "Simulated for the demo".
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localDay } from '../proactive/clock.js';
import type { Candidate } from '../proactive/policy.js';
import type { ProactiveStore } from '../proactive/store.js';

export const FireWatchBody = z.object({
  trip_id: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  person_ids: z.array(z.string().min(1).max(64)).max(30).default([]),
  status: z.enum(['scheduled', 'delayed', 'cancelled', 'departed', 'landed']).default('delayed'),
  delay_minutes: z.int().min(0).max(1440).default(120),
  arrive_at: z.iso.datetime({ offset: true }).optional(),
  note: z.string().min(1).max(200).optional(),
  importance: z.number().min(0).max(1).default(0.9),
  urgency: z.number().min(0).max(1).default(0.9),
  /** Rehearsals: today's earlier unprompted posts stop counting first. */
  reset_budget: z.boolean().default(false),
});

export interface FireDeps {
  adminToken: string | undefined;
  store: ProactiveStore;
  now: () => Date;
  promote: () => Promise<number>;
}

function sameToken(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export function registerFireRoute(app: FastifyInstance, d: FireDeps): void {
  app.post('/admin/watch/fire', async (req, reply) => {
    if (!d.adminToken) return reply.code(404).send(errorBody('not_found', 'admin is not set up'));
    const given = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!sameToken(given, d.adminToken)) return reply.code(401).send(errorBody('bad_signature', 'admin token required'));
    const parsed = FireWatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send(errorBody('invalid', z.prettifyError(parsed.error).slice(0, 500)));
    const b = parsed.data;
    if (!(await d.store.tripExists(b.trip_id))) return reply.code(404).send(errorBody('not_found', 'no such trip'));

    const now = d.now();
    if (b.reset_budget) await d.store.resetBudget(b.trip_id, localDay(now, await d.store.tripTz(b.trip_id)));
    const dedupeKey = `sim:flight_status:${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const c: Candidate = {
      tripId: b.trip_id,
      dedupeKey,
      source: 'watch',
      topic: 'flight_status',
      dueAt: now,
      expiresAt: new Date(now.getTime() + 2 * 3600_000),
      importance: b.importance,
      confidence: 1,
      urgency: b.urgency,
      useful: b.person_ids.length > 0 ? ['pin', 'message'] : ['message'],
      personIds: b.person_ids,
      facts: {
        label: b.label,
        status: b.status,
        delayMinutes: b.delay_minutes,
        simulated: true,
        ...(b.arrive_at ? { arriveAt: b.arrive_at } : {}),
        ...(b.note ? { note: b.note } : {}),
      },
      simulated: true,
      small: false,
    };
    await d.store.add(c);
    const promoted = await d.promote();
    return reply.send({ ok: true, dedupe_key: dedupeKey, promoted });
  });
}
```

```ts
// apps/brain/src/proactive/register.ts
// Wires proactive Go into the service: openings from the chat and trip changes, timers, watches, the
// promoter, the wake text, the openings block, the notice tools and the demo's "fire a watch".
import type { Brain, RegisterLane } from '../app.js';
import type { Trip } from '../door/methods.js';
import { registerFireRoute } from '../watches/admin.js';
import { noteWatchNotice, syncWatches } from '../watches/plan.js';
import { travelStatusPort, type StatusPort } from '../watches/port.js';
import { createWatchRunner } from '../watches/runner.js';
import { noticeTools } from './notice-tools.js';
import { createOpenings } from './openings.js';
import { PROACTIVE_KINDS, type ProactivePayload } from './payload.js';
import { createPromoter } from './promoter.js';
import { ProactiveStore } from './store.js';
import { replanTimers } from './timers.js';
import { openingsNow, renderWake } from './wake.js';

export const PROMOTE_EVERY_MS = 15_000;
export const WATCH_EVERY_MS = 30_000;
export const SWEEP_EVERY_MS = 10 * 60_000;
export const ACTIVE_TRIP_DAYS = 90;

export interface ProactiveHandles {
  store: ProactiveStore;
  promote(): Promise<number>;
  checkWatches(): Promise<number>;
  sweep(): Promise<void>;
  stop(): void;
}

export interface StartProactiveOpts {
  /** Tests pass false and drive the passes by hand. */
  intervals?: boolean;
  /** Overrides the status port built from `brain.travel`; null turns watches off. */
  port?: StatusPort | null;
}

export async function startProactive(brain: Brain, opts: StartProactiveOpts = {}): Promise<ProactiveHandles> {
  const store = new ProactiveStore(brain.pool);
  const log = brain.log;
  const promoter = createPromoter({ store, desk: brain.desk, packs: brain.packs, now: brain.now, log });
  const port = opts.port !== undefined ? opts.port : brain.travel ? travelStatusPort(brain.travel) : null;
  const watches = createWatchRunner({ pool: brain.pool, port, store, now: brain.now, log });
  const readTrip = (tripId: string): Promise<Trip> => brain.door.link.request('read_trip', { trip_id: tripId });
  const replan = async (tripId: string, trip: Trip): Promise<void> => {
    await replanTimers(store, trip, await store.tripTz(tripId), brain.now());
    await syncWatches(brain.pool, trip, brain.now());
  };
  const openings = createOpenings({ store, packs: brain.packs, readTrip, replan, now: brain.now });

  brain.hooks.onRead((msg, read, pack) => openings.onRead(msg, read, pack));
  brain.tripLog.onEvent((ev) => openings.onEvent(ev));
  for (const kind of PROACTIVE_KINDS) brain.context.addWake(kind, (item, pack) => renderWake(item, pack, brain.now()));
  brain.context.addNow(openingsNow());
  const onPosted = async (p: ProactivePayload, cardId: string): Promise<void> => {
    const watchId = p.candidate.facts.watchId;
    if (typeof watchId === 'string') await noteWatchNotice(brain.pool, watchId, cardId);
  };
  for (const tool of noticeTools({ store, now: brain.now, onPosted })) brain.tools.register(tool);
  registerFireRoute(brain.http, { adminToken: brain.env.ADMIN_TOKEN, store, now: brain.now, promote: () => promoter.tick() });

  /** Level-triggered: every active trip's timers and watches are re-planned from the trip as it is now. */
  const sweep = async (): Promise<void> => {
    const since = new Date(brain.now().getTime() - ACTIVE_TRIP_DAYS * 86_400_000);
    const trips = await brain.pool.query<{ trip_id: string }>(`select trip_id from trips where created_at > $1`, [since]);
    for (const { trip_id } of trips.rows) {
      try {
        await replan(trip_id, await readTrip(trip_id));
      } catch (err) {
        log.warn({ err, tripId: trip_id }, 'proactive: the sweep could not re-plan a trip');
      }
    }
    await openings.checkIgnored();
  };

  const handles: NodeJS.Timeout[] = [];
  if (opts.intervals !== false) {
    const every = (ms: number, what: string, fn: () => Promise<unknown>): void => {
      const h = setInterval(() => {
        fn().catch((err: unknown) => log.warn({ err }, `proactive: ${what} failed`));
      }, ms);
      h.unref();
      handles.push(h);
    };
    every(PROMOTE_EVERY_MS, 'promote', () => promoter.tick());
    every(WATCH_EVERY_MS, 'watch check', () => watches.tick());
    every(SWEEP_EVERY_MS, 'sweep', sweep);
  }

  return {
    store,
    promote: () => promoter.tick(),
    checkWatches: () => watches.tick(),
    sweep,
    stop: () => handles.forEach((h) => clearInterval(h)),
  };
}

export const registerProactive: RegisterLane = async (brain) => {
  await startProactive(brain);
};
```

```ts
// apps/brain/src/main.ts (modify: add the import with the other lane imports, and the call after registerMoney)
import { registerProactive } from './proactive/register.js';
// ...
await registerProactive(brain);
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/watches/runner.ts apps/brain/src/watches/admin.ts apps/brain/src/proactive/register.ts apps/brain/src/main.ts apps/brain/src/watches/runner.test.ts apps/brain/src/proactive/register.test.ts
git commit -m "feat(proactive): watch checks, the demo's simulated watch, and proactive Go wired into the service

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `runner.test.ts` and `register.test.ts` pass (including the 3:40 demo beat); earlier tests stay green.

### Task 9: Call foundations (settings, the allowlist, "stop" in Hinglish, the call row)

**Files:**
- Create: `apps/brain/src/db/migrations/5200_calls.sql`
- Create: `apps/brain/src/calls/config.ts`
- Create: `apps/brain/src/calls/stop-words.ts`
- Create: `apps/brain/src/calls/store.ts`
- Test: `apps/brain/src/calls/foundation.test.ts`

**Interfaces:**
- Consumes: `withSchema()` (P1); `Env` fields `GO_PUBLIC_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `OPENAI_API_KEY`, `CALLS_ALLOWLIST` (P1 declares them optional in `calls/env.ts`; this plan reads them through `brain.env` and does not edit that file).
- Produces:
  - `config.ts`: `CALL_WINDOW_MS = 30_000`, `CALL_CAP_MS = 240_000`, `RING_TIMEOUT_S = 30`, `TWILIO_TIME_LIMIT_S = 255`, `CARD_GAP_MS = 3_000`, `REALTIME_URL`, `REALTIME_MODEL = 'gpt-realtime-2.1'`, `REALTIME_VOICE = 'marin'`, `TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe'`, `E164`; `interface Callee { name: string | null; phone: string }`; `interface CallsEnvInput`; `interface CallsConfig { publicUrl; accountSid; authToken; from; openaiKey: string | null; allowlist: Callee[]; missing: string[] }`; `normalisePhone(raw): string | null`; `parseAllowlist(raw): Callee[]`; `loadCallsConfig(env): CallsConfig`; `findCallee(cfg, { business, phone? }): Callee | null`; `statusUrl(publicUrl, callId)`; `mediaUrl(publicUrl, callId)`; `maskPhone(phone)`.
  - `stop-words.ts`: `saysStop(text, repliesToCallLine: boolean): boolean`.
  - `store.ts`: `type CallState = 'waiting' | 'cancelled' | 'dialing' | 'talking' | 'ended' | 'failed'`; `interface CallLine { who: 'go' | 'them'; text: string }`; `interface RecordAsk { kind: 'agreed' | 'open'; text: string }`; `interface CallRow` (camelCase of the table); `interface NewCall`; `class CallStore` with `create`, `get`, `byCard`, `liveFor`, `recentlyCancelled`, `announced`, `cancel`, `dueToDial`, `startDialing`, `dialInfo`, `claimMedia`, `talking`, `end`, `inCall`, `toCloseOut`, `closedOut`.

`CALLS_ALLOWLIST` entries are `+E164` or `Name=+E164` (for example `Villa Sol=+919800000001,+919800000002`). A name lets the composer call by the business's name, and the "Go can phone" block (Task 13) lists names only, never numbers. Every state change is a single conditional `update ... where state = any(...)`, so two paths racing (the status callback and the media socket closing) end a call once.

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/calls/foundation.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import { findCallee, loadCallsConfig, maskPhone, mediaUrl, normalisePhone, parseAllowlist, statusUrl } from './config.js';
import { saysStop } from './stop-words.js';
import { CallStore, type NewCall } from './store.js';

describe('config', () => {
  it('reads phone numbers in E.164 only', () => {
    expect(normalisePhone('+91 98000-00001')).toBe('+919800000001');
    expect(normalisePhone('0091 98000 00001')).toBe('+919800000001');
    expect(normalisePhone('9800000001')).toBeNull();
    expect(normalisePhone('+0123')).toBeNull();
  });

  it('parses the allowlist with optional names and skips junk', () => {
    expect(parseAllowlist('Villa Sol=+91 98000 00001, +14155550100, nonsense, Kabir Cabs=0091-9800000002,')).toEqual([
      { name: 'Villa Sol', phone: '+919800000001' },
      { name: null, phone: '+14155550100' },
      { name: 'Kabir Cabs', phone: '+919800000002' },
    ]);
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it('finds a callee by name or by number, and nothing off the list', () => {
    const cfg = { allowlist: parseAllowlist('Villa Sol=+919800000001,+14155550100') };
    expect(findCallee(cfg, { business: 'villa sol' })).toEqual({ name: 'Villa Sol', phone: '+919800000001' });
    expect(findCallee(cfg, { business: 'Anyone', phone: '+1 415 555 0100' })).toEqual({ name: null, phone: '+14155550100' });
    expect(findCallee(cfg, { business: 'Villa Sol', phone: '+919999999999' })).toBeNull();
    expect(findCallee(cfg, { business: 'Casa Azul' })).toBeNull();
  });

  it('says what is missing, and builds the public URLs', () => {
    const cfg = loadCallsConfig({ GO_PUBLIC_URL: 'https://brain.test/', TWILIO_ACCOUNT_SID: 'ACx', CALLS_ALLOWLIST: '+919800000001' });
    expect(cfg.missing).toEqual(['TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'OPENAI_API_KEY']);
    expect(cfg.publicUrl).toBe('https://brain.test');
    expect(statusUrl('https://brain.test', 'call_1')).toBe('https://brain.test/calls/twilio/status/call_1');
    expect(mediaUrl('https://brain.test', 'call_1')).toBe('wss://brain.test/calls/media/call_1');
    expect(maskPhone('+919800000001')).toBe('+91***001');
  });
});

describe('saysStop', () => {
  it('hears stop in English and Hinglish', () => {
    for (const t of ['stop', 'STOP!!', 'Go ruko', 'ruk jao bhai', 'band karo', 'mat karo yaar', "don't call them", 'wait, hold on']) {
      expect(saysStop(t, false), t).toBe(true);
    }
  });
  it('takes a bare no only as a reply to the call line', () => {
    expect(saysStop('nahi', true)).toBe(true);
    expect(saysStop('no', true)).toBe(true);
    expect(saysStop('nahi', false)).toBe(false);
  });
  it('does not stop for ordinary chat', () => {
    for (const t of ['sounds good', 'non-stop flight hai kya?', 'nonstop party in Goa', 'ok cool', null, '']) {
      expect(saysStop(t, false), String(t)).toBe(false);
    }
  });
});

describe('CallStore', () => {
  let db: Awaited<ReturnType<typeof withSchema>>;
  let store: CallStore;
  const at = new Date('2026-10-06T10:00:00Z');
  const call = (over: Partial<NewCall> = {}): NewCall => ({
    callId: 'call_1', tripId: 't_goa', business: 'Villa Sol', phone: '+919800000001', goal: 'Ask if we can check in at 10 am',
    factsAllowed: ['Group of five', 'Staying 6 to 9 November'], forWhom: 'a group of 5 friends travelling together',
    askedByPersonId: 'p_arjun', askedMessageId: 'm_300', cardId: 'c_call_1', dialAt: new Date(at.getTime() + 30_000), ...over,
  });
  beforeAll(async () => {
    db = await withSchema();
    store = new CallStore(db.pool);
  });
  afterAll(async () => {
    await db.drop();
  });

  it('moves through its states once each', async () => {
    const row = await store.create(call());
    expect(row).toMatchObject({ state: 'waiting', business: 'Villa Sol', factsAllowed: ['Group of five', 'Staying 6 to 9 November'], transcript: [] });
    expect((await store.liveFor('t_goa'))?.callId).toBe('call_1');
    await store.announced('call_1', 'm_go_1', 301);
    expect((await store.get('call_1'))?.announceSeq).toBe(301);

    expect(await store.dueToDial(at)).toEqual([]);
    expect((await store.dueToDial(new Date(at.getTime() + 30_000))).map((r) => r.callId)).toEqual(['call_1']);
    expect((await store.startDialing('call_1'))?.state).toBe('dialing');
    expect(await store.startDialing('call_1')).toBeNull();
    expect(await store.cancel('call_1', 'too_late', at)).toBeNull();

    await store.dialInfo('call_1', { cardMessageId: 'm_go_2', tokenHash: 'h1' });
    await store.dialInfo('call_1', { twilioSid: 'CA1' });
    expect(await store.get('call_1')).toMatchObject({ cardMessageId: 'm_go_2', twilioSid: 'CA1' });
    expect((await store.byCard('t_goa', 'c_call_1'))?.callId).toBe('call_1');

    expect(await store.claimMedia('call_1', 'wrong')).toBeNull();
    expect((await store.claimMedia('call_1', 'h1'))?.callId).toBe('call_1');
    expect(await store.claimMedia('call_1', 'h1')).toBeNull();

    expect((await store.talking('call_1', at))?.state).toBe('talking');
    expect((await store.inCall()).map((r) => r.callId)).toEqual(['call_1']);
    const ended = await store.end('call_1', { state: 'ended', at, outcome: '10 am is fine.', reported: true, record: { kind: 'agreed', text: 'Check-in at 10 am is fine' }, transcript: [{ who: 'them', text: 'Yes, 10 is fine.' }], reason: 'hangup' });
    expect(ended).toMatchObject({ state: 'ended', reported: true, record: { kind: 'agreed' }, transcript: [{ who: 'them', text: 'Yes, 10 is fine.' }] });
    expect(await store.end('call_1', { state: 'failed', at, outcome: 'x', reported: false, record: null, transcript: [], reason: 'busy' })).toBeNull();

    expect((await store.toCloseOut(new Date(at.getTime() + 1000))).map((r) => r.callId)).toEqual(['call_1']);
    await store.closedOut('call_1', at, 'r_9');
    expect(await store.toCloseOut(new Date(at.getTime() + 1000))).toEqual([]);
    expect(await store.liveFor('t_goa')).toBeNull();
  });

  it('cancels a waiting call once and remembers it for a while', async () => {
    await store.create(call({ callId: 'call_2', cardId: 'c_call_2' }));
    expect((await store.cancel('call_2', 'stopped_by:p_priya', at))?.state).toBe('cancelled');
    expect(await store.cancel('call_2', 'again', at)).toBeNull();
    expect((await store.recentlyCancelled('t_goa', new Date(at.getTime() - 60_000)))?.callId).toBe('call_2');
    expect(await store.recentlyCancelled('t_goa', new Date(at.getTime() + 60_000))).toBeNull();
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the modules do not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```sql
-- apps/brain/src/db/migrations/5200_calls.sql
-- Phone calls Go makes for a trip. Only the transcript is kept; audio never is.
create table calls (
  call_id text primary key,
  trip_id text not null,
  business text not null,
  phone text not null,
  goal text not null,
  facts_allowed text[] not null default '{}',
  for_whom text not null,
  state text not null check (state in ('waiting', 'cancelled', 'dialing', 'talking', 'ended', 'failed')),
  asked_by_person_id text,
  asked_message_id text,
  announce_message_id text,
  announce_seq integer,
  card_id text not null,
  card_message_id text,
  dial_at timestamptz not null,
  media_token_hash text,
  media_token_used boolean not null default false,
  twilio_sid text,
  started_at timestamptz,
  ended_at timestamptz,
  outcome text,
  reported boolean not null default false,
  record jsonb,
  transcript jsonb not null default '[]',
  end_reason text,
  record_line_id text,
  closed_out_at timestamptz,
  created_at timestamptz not null default now(),
  unique (trip_id, card_id)
);
create index calls_live on calls (trip_id) where state in ('waiting', 'dialing', 'talking');
create index calls_due on calls (dial_at) where state = 'waiting';
```

```ts
// apps/brain/src/calls/config.ts
// Calls: the settings, the allowlist, phone numbers, the public URLs and the fixed numbers.
export const CALL_WINDOW_MS = 30_000;
export const CALL_CAP_MS = 240_000;
export const RING_TIMEOUT_S = 30;
/** Twilio's own hard limit, a backstop behind Go's 4 minute cap. */
export const TWILIO_TIME_LIMIT_S = 255;
export const CARD_GAP_MS = 3_000;
export const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
export const REALTIME_MODEL = 'gpt-realtime-2.1';
export const REALTIME_VOICE = 'marin';
/** The realtime session's own input transcription (no separate speech-to-text service). */
export const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
export const E164 = /^\+[1-9]\d{6,14}$/;

export interface Callee { name: string | null; phone: string }

export interface CallsEnvInput {
  GO_PUBLIC_URL?: string | undefined;
  TWILIO_ACCOUNT_SID?: string | undefined;
  TWILIO_AUTH_TOKEN?: string | undefined;
  TWILIO_FROM?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  CALLS_ALLOWLIST?: string | undefined;
}

export interface CallsConfig {
  publicUrl: string | null;
  accountSid: string | null;
  authToken: string | null;
  from: string | null;
  openaiKey: string | null;
  allowlist: Callee[];
  /** Names of settings that are not set; calls refuse to start while any is missing. */
  missing: string[];
}

export function normalisePhone(raw: string): string | null {
  const compact = raw.replace(/[\s\-().]/g, '');
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return E164.test(withPlus) ? withPlus : null;
}

export function parseAllowlist(raw: string | undefined): Callee[] {
  if (!raw) return [];
  const out: Callee[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.lastIndexOf('=');
    const name = eq > 0 ? entry.slice(0, eq).trim() : '';
    const phone = normalisePhone(eq > 0 ? entry.slice(eq + 1) : entry);
    if (phone) out.push({ name: name || null, phone });
  }
  return out;
}

export function loadCallsConfig(env: CallsEnvInput): CallsConfig {
  const v = (s: string | undefined): string | null => (s && s.trim() ? s.trim() : null);
  const publicUrl = v(env.GO_PUBLIC_URL)?.replace(/\/+$/, '') ?? null;
  const from = env.TWILIO_FROM ? normalisePhone(env.TWILIO_FROM) : null;
  const set: Record<string, string | null> = {
    GO_PUBLIC_URL: publicUrl,
    TWILIO_ACCOUNT_SID: v(env.TWILIO_ACCOUNT_SID),
    TWILIO_AUTH_TOKEN: v(env.TWILIO_AUTH_TOKEN),
    TWILIO_FROM: from,
    OPENAI_API_KEY: v(env.OPENAI_API_KEY),
  };
  return {
    publicUrl,
    accountSid: set.TWILIO_ACCOUNT_SID ?? null,
    authToken: set.TWILIO_AUTH_TOKEN ?? null,
    from,
    openaiKey: set.OPENAI_API_KEY ?? null,
    allowlist: parseAllowlist(env.CALLS_ALLOWLIST),
    missing: Object.entries(set).filter(([, value]) => value === null).map(([key]) => key),
  };
}

/** A number given must be on the list; with no number, a listed name must match exactly (any case). */
export function findCallee(cfg: Pick<CallsConfig, 'allowlist'>, o: { business: string; phone?: string | undefined }): Callee | null {
  if (o.phone) {
    const phone = normalisePhone(o.phone);
    return phone ? (cfg.allowlist.find((c) => c.phone === phone) ?? null) : null;
  }
  const want = o.business.trim().toLowerCase();
  return cfg.allowlist.find((c) => c.name !== null && c.name.toLowerCase() === want) ?? null;
}

export const statusUrl = (publicUrl: string, callId: string): string => `${publicUrl}/calls/twilio/status/${callId}`;
export const mediaUrl = (publicUrl: string, callId: string): string => `wss://${new URL(publicUrl).host}/calls/media/${callId}`;
/** For logs: never a whole phone number. */
export const maskPhone = (phone: string): string => (phone.length <= 6 ? '***' : `${phone.slice(0, 3)}***${phone.slice(-3)}`);
```

```ts
// apps/brain/src/calls/stop-words.ts
// "Stop" in the 30 seconds before Go dials, in English and Hinglish. When unsure, stopping is the safe side.
const STOP = /\b(stop|ruko|rukk?o|ruk\s*jao|ruk\s*ja|band\s*karo|band\s*kar|mat\s*karo|mat\s*kar|cancel|don'?t\s+call|do\s+not\s+call|hold\s+on|wait)\b/i;
/** A bare "no" only counts as a reply to Go's call line. */
const NO = /\b(no|nahi|nahin|nai|na|mat)\b/i;

export function saysStop(text: string | null | undefined, repliesToCallLine: boolean): boolean {
  if (!text) return false;
  const t = text.toLowerCase().replace(/non[\s-]?stop/g, ' ');
  return STOP.test(t) || (repliesToCallLine && NO.test(t));
}
```

```ts
// apps/brain/src/calls/store.ts
// The call row and its state changes. Each change is one conditional update, so racing paths end a call once.
import type pg from 'pg';

export type CallState = 'waiting' | 'cancelled' | 'dialing' | 'talking' | 'ended' | 'failed';
export interface CallLine { who: 'go' | 'them'; text: string }
export interface RecordAsk { kind: 'agreed' | 'open'; text: string }

export interface CallRow {
  callId: string;
  tripId: string;
  business: string;
  phone: string;
  goal: string;
  factsAllowed: string[];
  forWhom: string;
  state: CallState;
  askedByPersonId: string | null;
  askedMessageId: string | null;
  announceMessageId: string | null;
  announceSeq: number | null;
  cardId: string;
  cardMessageId: string | null;
  dialAt: Date;
  twilioSid: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  outcome: string | null;
  reported: boolean;
  record: RecordAsk | null;
  transcript: CallLine[];
  endReason: string | null;
  recordLineId: string | null;
  closedOutAt: Date | null;
}

export interface NewCall {
  callId: string;
  tripId: string;
  business: string;
  phone: string;
  goal: string;
  factsAllowed: string[];
  forWhom: string;
  askedByPersonId: string | null;
  askedMessageId: string | null;
  cardId: string;
  dialAt: Date;
}

type Row = {
  call_id: string; trip_id: string; business: string; phone: string; goal: string; facts_allowed: string[]; for_whom: string;
  state: CallState; asked_by_person_id: string | null; asked_message_id: string | null; announce_message_id: string | null;
  announce_seq: number | null; card_id: string; card_message_id: string | null; dial_at: Date; twilio_sid: string | null;
  started_at: Date | null; ended_at: Date | null; outcome: string | null; reported: boolean; record: RecordAsk | null;
  transcript: CallLine[]; end_reason: string | null; record_line_id: string | null; closed_out_at: Date | null;
};

const toRow = (r: Row): CallRow => ({
  callId: r.call_id, tripId: r.trip_id, business: r.business, phone: r.phone, goal: r.goal, factsAllowed: r.facts_allowed,
  forWhom: r.for_whom, state: r.state, askedByPersonId: r.asked_by_person_id, askedMessageId: r.asked_message_id,
  announceMessageId: r.announce_message_id, announceSeq: r.announce_seq, cardId: r.card_id, cardMessageId: r.card_message_id,
  dialAt: r.dial_at, twilioSid: r.twilio_sid, startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome,
  reported: r.reported, record: r.record, transcript: r.transcript, endReason: r.end_reason, recordLineId: r.record_line_id,
  closedOutAt: r.closed_out_at,
});

export class CallStore {
  constructor(private readonly pool: pg.Pool) {}

  private async one(sql: string, params: unknown[]): Promise<CallRow | null> {
    const r = await this.pool.query<Row>(sql, params);
    const row = r.rows[0];
    return row ? toRow(row) : null;
  }

  private async many(sql: string, params: unknown[]): Promise<CallRow[]> {
    return (await this.pool.query<Row>(sql, params)).rows.map(toRow);
  }

  async create(c: NewCall): Promise<CallRow> {
    const row = await this.one(
      `insert into calls (call_id, trip_id, business, phone, goal, facts_allowed, for_whom, state, asked_by_person_id, asked_message_id, card_id, dial_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'waiting', $8, $9, $10, $11) returning *`,
      [c.callId, c.tripId, c.business, c.phone, c.goal, c.factsAllowed, c.forWhom, c.askedByPersonId, c.askedMessageId, c.cardId, c.dialAt],
    );
    if (!row) throw new Error('calls: insert returned nothing');
    return row;
  }

  get(callId: string): Promise<CallRow | null> {
    return this.one(`select * from calls where call_id = $1`, [callId]);
  }

  byCard(tripId: string, cardId: string): Promise<CallRow | null> {
    return this.one(`select * from calls where trip_id = $1 and card_id = $2`, [tripId, cardId]);
  }

  liveFor(tripId: string): Promise<CallRow | null> {
    return this.one(`select * from calls where trip_id = $1 and state in ('waiting', 'dialing', 'talking') order by created_at desc limit 1`, [tripId]);
  }

  recentlyCancelled(tripId: string, since: Date): Promise<CallRow | null> {
    return this.one(`select * from calls where trip_id = $1 and state = 'cancelled' and ended_at >= $2 order by ended_at desc limit 1`, [tripId, since]);
  }

  async announced(callId: string, messageId: string, seq: number): Promise<void> {
    await this.pool.query(`update calls set announce_message_id = $2, announce_seq = $3 where call_id = $1`, [callId, messageId, seq]);
  }

  cancel(callId: string, reason: string, at: Date): Promise<CallRow | null> {
    return this.one(`update calls set state = 'cancelled', end_reason = $2, ended_at = $3 where call_id = $1 and state = 'waiting' returning *`, [callId, reason, at]);
  }

  dueToDial(now: Date): Promise<CallRow[]> {
    return this.many(`select * from calls where state = 'waiting' and dial_at <= $1 order by dial_at`, [now]);
  }

  startDialing(callId: string): Promise<CallRow | null> {
    return this.one(`update calls set state = 'dialing' where call_id = $1 and state = 'waiting' returning *`, [callId]);
  }

  async dialInfo(callId: string, o: { cardMessageId?: string; tokenHash?: string; twilioSid?: string }): Promise<void> {
    await this.pool.query(
      `update calls set card_message_id = coalesce($2, card_message_id), media_token_hash = coalesce($3, media_token_hash),
         twilio_sid = coalesce($4, twilio_sid) where call_id = $1`,
      [callId, o.cardMessageId ?? null, o.tokenHash ?? null, o.twilioSid ?? null],
    );
  }

  /** The media socket's one-use token: right hash, not used, call still live. */
  claimMedia(callId: string, tokenHash: string): Promise<CallRow | null> {
    return this.one(
      `update calls set media_token_used = true
       where call_id = $1 and media_token_hash = $2 and not media_token_used and state in ('dialing', 'talking') returning *`,
      [callId, tokenHash],
    );
  }

  talking(callId: string, at: Date): Promise<CallRow | null> {
    return this.one(`update calls set state = 'talking', started_at = coalesce(started_at, $2) where call_id = $1 and state = 'dialing' returning *`, [callId, at]);
  }

  end(callId: string, o: { state: 'ended' | 'failed'; at: Date; outcome: string; reported: boolean; record: RecordAsk | null; transcript: CallLine[]; reason: string }): Promise<CallRow | null> {
    return this.one(
      `update calls set state = $2, ended_at = $3, outcome = $4, reported = $5, record = $6, transcript = $7, end_reason = $8
       where call_id = $1 and state in ('dialing', 'talking') returning *`,
      [callId, o.state, o.at, o.outcome, o.reported, o.record ? JSON.stringify(o.record) : null, JSON.stringify(o.transcript), o.reason],
    );
  }

  inCall(): Promise<CallRow[]> {
    return this.many(`select * from calls where state in ('dialing', 'talking') order by dial_at`, []);
  }

  toCloseOut(before: Date): Promise<CallRow[]> {
    return this.many(`select * from calls where state in ('ended', 'failed') and closed_out_at is null and ended_at < $1 order by ended_at`, [before]);
  }

  async closedOut(callId: string, at: Date, recordLineId: string | null): Promise<void> {
    await this.pool.query(`update calls set closed_out_at = $2, record_line_id = coalesce($3, record_line_id) where call_id = $1`, [callId, at, recordLineId]);
  }
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/db/migrations/5200_calls.sql apps/brain/src/calls/config.ts apps/brain/src/calls/stop-words.ts apps/brain/src/calls/store.ts apps/brain/src/calls/foundation.test.ts
git commit -m "feat(calls): the allowlist, stop in English and Hinglish, and a call row that ends once

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `foundation.test.ts` passes; earlier tests stay green.

### Task 10: Twilio over its REST API (place a call, hang up, TwiML, the signature check)

**Files:**
- Create: `apps/brain/src/calls/twilio.ts`
- Test: `apps/brain/src/calls/twilio.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `interface CreateCall { to; from; twiml; statusCallback: string; timeLimitS: number; ringTimeoutS: number }`; `interface TwilioClient { createCall(p: CreateCall): Promise<{ sid: string }>; hangUp(sid: string): Promise<void> }`; `class TwilioError extends Error { status: number; code: number | null }`; `twilioClient(o: { accountSid; authToken; fetch?: typeof fetch; baseUrl?: string }): TwilioClient`; `streamTwiml(o: { url: string; token: string }): string`; `verifyTwilioSignature(authToken: string | null, url: string, params: Record<string, string>, header: string | string[] | undefined): boolean`; `type TwilioOutcome`; `twilioOutcome(status: string): TwilioOutcome`.

Decisions:
- **No `twilio` SDK.** Two REST calls with `fetch` and Basic auth, the same shape as Bash's WhatsApp adapter (`Messages.json` with Basic auth).
- **The one-use media token travels as a `<Parameter>`, not `?token=` on the stream URL.** Twilio's `<Stream url>` does not carry query strings to the socket; custom parameters arrive in the `start` message (`start.customParameters.token`). The path still names the call: `wss://<GO_PUBLIC_URL host>/calls/media/<call_id>`.
- **Status callbacks are signed by Twilio** (HMAC-SHA1 of the exact public URL plus the sorted form parameters, base64, header `X-Twilio-Signature`). Go builds that URL itself from `GO_PUBLIC_URL`, the same string it gave Twilio, so Railway's proxy rewriting host or scheme cannot break the check. This is Bash's `verifyInboundWithBody` from `whatsapp-twilio.adapter.ts`.
- `Record=false` is sent explicitly: audio is never recorded.

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/calls/twilio.test.ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TwilioError, streamTwiml, twilioClient, twilioOutcome, verifyTwilioSignature } from './twilio.js';

function capture(status = 201, body: unknown = { sid: 'CA123', status: 'queued' }) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetchFake };
}

describe('twilioClient', () => {
  it('places a call with TwiML, a signed status callback, a time limit and no recording', async () => {
    const { seen, fetchFake } = capture();
    const client = twilioClient({ accountSid: 'AC_test', authToken: 'tok_test', fetch: fetchFake });
    const twiml = streamTwiml({ url: 'wss://brain.test/calls/media/call_1', token: 'one-use' });
    expect(await client.createCall({ to: '+919800000001', from: '+14155550100', twiml, statusCallback: 'https://brain.test/calls/twilio/status/call_1', timeLimitS: 255, ringTimeoutS: 30 })).toEqual({ sid: 'CA123' });

    const [req] = seen;
    expect(req?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls.json');
    expect(req?.init.method).toBe('POST');
    const headers = req?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('AC_test:tok_test').toString('base64')}`);
    const form = new URLSearchParams(String(req?.init.body));
    expect(form.get('To')).toBe('+919800000001');
    expect(form.get('From')).toBe('+14155550100');
    expect(form.get('Twiml')).toBe(twiml);
    expect(form.get('StatusCallback')).toBe('https://brain.test/calls/twilio/status/call_1');
    expect(form.getAll('StatusCallbackEvent')).toEqual(['initiated', 'ringing', 'answered', 'completed']);
    expect(form.get('TimeLimit')).toBe('255');
    expect(form.get('Timeout')).toBe('30');
    expect(form.get('Record')).toBe('false');
  });

  it('hangs up by setting the call completed', async () => {
    const { seen, fetchFake } = capture(200, { sid: 'CA123', status: 'completed' });
    await twilioClient({ accountSid: 'AC_test', authToken: 'tok_test', fetch: fetchFake }).hangUp('CA123');
    expect(seen[0]?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls/CA123.json');
    expect(new URLSearchParams(String(seen[0]?.init.body)).get('Status')).toBe('completed');
  });

  it('turns a refusal into a TwilioError with Twilio code', async () => {
    const { fetchFake } = capture(400, { code: 21215, message: 'Account not authorized to call +919800000001.' });
    const err = await twilioClient({ accountSid: 'AC_test', authToken: 'tok_test', fetch: fetchFake })
      .createCall({ to: '+919800000001', from: '+14155550100', twiml: '<Response/>', statusCallback: 'https://brain.test/x', timeLimitS: 1, ringTimeoutS: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TwilioError);
    expect(err).toMatchObject({ status: 400, code: 21215 });
  });
});

describe('streamTwiml', () => {
  it('connects a stream and passes the token as a parameter, escaped', () => {
    const xml = streamTwiml({ url: 'wss://brain.test/calls/media/call_1', token: 'a"b<c>&d' });
    expect(xml).toContain('<Connect><Stream url="wss://brain.test/calls/media/call_1">');
    expect(xml).toContain('<Parameter name="token" value="a&quot;b&lt;c&gt;&amp;d"/>');
    expect(xml).not.toContain('?token=');
  });
});

describe('verifyTwilioSignature', () => {
  const url = 'https://brain.test/calls/twilio/status/call_1';
  const params = { CallSid: 'CA123', CallStatus: 'completed', AccountSid: 'AC_test', CallDuration: '41' };
  const sign = (token: string, u: string, p: Record<string, string>): string =>
    createHmac('sha1', token).update(Object.keys(p).sort().reduce((acc, k) => acc + k + p[k], u)).digest('base64');

  it('accepts a request Twilio signed for this exact URL', () => {
    expect(verifyTwilioSignature('tok_test', url, params, sign('tok_test', url, params))).toBe(true);
    expect(verifyTwilioSignature('tok_test', url, params, [sign('tok_test', url, params)])).toBe(true);
  });

  it('refuses a changed parameter, another URL, a missing header or no token', () => {
    const good = sign('tok_test', url, params);
    expect(verifyTwilioSignature('tok_test', url, { ...params, CallStatus: 'busy' }, good)).toBe(false);
    expect(verifyTwilioSignature('tok_test', 'http://brain.test/calls/twilio/status/call_1', params, good)).toBe(false);
    expect(verifyTwilioSignature('tok_test', url, params, undefined)).toBe(false);
    expect(verifyTwilioSignature(null, url, params, good)).toBe(false);
  });
});

describe('twilioOutcome', () => {
  it('maps Twilio call statuses', () => {
    expect(twilioOutcome('ringing')).toBe('ringing');
    expect(twilioOutcome('in-progress')).toBe('answered');
    expect(twilioOutcome('completed')).toBe('completed');
    expect(twilioOutcome('busy')).toBe('busy');
    expect(twilioOutcome('no-answer')).toBe('no_answer');
    expect(twilioOutcome('failed')).toBe('failed');
    expect(twilioOutcome('canceled')).toBe('canceled');
    expect(twilioOutcome('something-new')).toBe('other');
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the module does not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/brain/src/calls/twilio.ts
// Twilio Programmable Voice over its REST API: place a call that streams to Go, hang up, check that a
// status callback really came from Twilio. No SDK: two form posts with Basic auth.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CreateCall {
  to: string;
  from: string;
  twiml: string;
  statusCallback: string;
  timeLimitS: number;
  ringTimeoutS: number;
}

export interface TwilioClient {
  createCall(p: CreateCall): Promise<{ sid: string }>;
  hangUp(sid: string): Promise<void>;
}

export class TwilioError extends Error {
  constructor(readonly status: number, readonly code: number | null, message: string) {
    super(message);
    this.name = 'TwilioError';
  }
}

export function twilioClient(o: { accountSid: string; authToken: string; fetch?: typeof fetch; baseUrl?: string }): TwilioClient {
  const base = `${o.baseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${encodeURIComponent(o.accountSid)}`;
  const authorization = `Basic ${Buffer.from(`${o.accountSid}:${o.authToken}`).toString('base64')}`;
  const send = o.fetch ?? fetch;

  async function post(path: string, form: URLSearchParams): Promise<Record<string, unknown>> {
    const res = await send(`${base}${path}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (!res.ok) {
      throw new TwilioError(res.status, typeof body.code === 'number' ? body.code : null, typeof body.message === 'string' ? body.message : `Twilio answered ${res.status}`);
    }
    return body;
  }

  return {
    async createCall(p) {
      const form = new URLSearchParams({
        To: p.to,
        From: p.from,
        Twiml: p.twiml,
        StatusCallback: p.statusCallback,
        StatusCallbackMethod: 'POST',
        TimeLimit: String(p.timeLimitS),
        Timeout: String(p.ringTimeoutS),
        Record: 'false',
      });
      for (const event of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', event);
      const body = await post('/Calls.json', form);
      if (typeof body.sid !== 'string') throw new TwilioError(502, null, 'Twilio answered without a call sid');
      return { sid: body.sid };
    },
    async hangUp(sid) {
      await post(`/Calls/${encodeURIComponent(sid)}.json`, new URLSearchParams({ Status: 'completed' }));
    },
  };
}

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Connects the call's audio to Go's media socket. The one-use token rides as a custom parameter. */
export function streamTwiml(o: { url: string; token: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(o.url)}"><Parameter name="token" value="${xml(o.token)}"/></Stream></Connect></Response>`;
}

/** Twilio signs the exact URL it called plus the sorted form parameters (HMAC-SHA1, base64). */
export function verifyTwilioSignature(authToken: string | null, url: string, params: Record<string, string>, header: string | string[] | undefined): boolean {
  if (!authToken) return false;
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) return false;
  const signed = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = createHmac('sha1', authToken).update(Buffer.from(signed, 'utf-8')).digest('base64');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type TwilioOutcome = 'ringing' | 'answered' | 'completed' | 'busy' | 'no_answer' | 'failed' | 'canceled' | 'other';

export function twilioOutcome(status: string): TwilioOutcome {
  switch (status) {
    case 'queued':
    case 'initiated':
    case 'ringing':
      return 'ringing';
    case 'in-progress':
      return 'answered';
    case 'completed':
      return 'completed';
    case 'busy':
      return 'busy';
    case 'no-answer':
      return 'no_answer';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return 'other';
  }
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/calls/twilio.ts apps/brain/src/calls/twilio.test.ts
git commit -m "feat(calls): place and end Twilio calls over REST, stream to Go, and check Twilio's signature

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `twilio.test.ts` passes; earlier tests stay green.

### Task 11: The live call (Twilio media socket to the realtime voice model)

**Files:**
- Create: `apps/brain/src/calls/realtime.ts`
- Create: `apps/brain/src/calls/bridge.ts`
- Test: `apps/brain/src/calls/bridge.test.ts`

**Interfaces:**
- Consumes: `Schedule` (Task 1); `CallLine` (Task 9); `manualTime`, `waitFor` (Task 2).
- Produces:
  - `realtime.ts`: `interface CallBrief { business; goal; factsAllowed: string[]; forWhom: string }`; `interface SessionSettings { model; voice; transcribeModel: string }`; `callInstructions(b): string`; `REPORT_OUTCOME_TOOL`; `ReportedOutcome` (zod: `{ outcome: string 1..500; answered: boolean; record?: { kind: 'agreed' | 'open'; text: string 1..200 } | null }`) and its type; `sessionUpdate(b, o): Record<string, unknown>`; `openRealtime(o: { url; model; apiKey }): WebSocket`.
  - `bridge.ts`: `type EndReason = 'hangup' | 'cap' | 'error'`; `interface BridgeHooks { talking(callId): Promise<void>; line(callId, line: CallLine): void; outcome(callId, o: ReportedOutcome): void; ended(callId, reason: EndReason): Promise<void> }`; `interface BridgeDeps { claim(callId, token): Promise<CallBrief | null>; openRealtime(): WebSocket; hangUp(callId): Promise<void>; hooks: BridgeHooks; schedule: Schedule; capMs: number; session: SessionSettings; log }`; `GREET_AFTER_MS = 4_000`, `WRAP_UP_BEFORE_MS = 20_000`, `HANG_UP_AFTER_GOODBYE_MS = 2_500`, `HANG_UP_AFTER_REPORT_MS = 15_000`; `attachBridge(twilio: WebSocket, callId: string, deps: BridgeDeps): void`.

How a call runs (research/hands.md §4c, §4d):
1. Twilio connects to `/calls/media/<call_id>` and sends `connected`, then `start` with `customParameters.token`. Nothing else happens until `claim` accepts the one-use token; a wrong token closes the socket with 1008 and ends nothing (an attacker who guesses a call id cannot end a real call).
2. The bridge opens the realtime socket and sends `session.update` with `audio/pcmu` in and out (Twilio's 8 kHz μ-law passes through byte for byte), server voice activity detection, the session's own input transcription, Go's instructions and the `report_outcome` tool.
3. Go waits for the business to say hello; if nobody speaks in 4 s, Go speaks first (`response.create`).
4. Twilio `media` frames go to `input_audio_buffer.append`; model audio deltas go back as Twilio `media` frames.
5. **Barge-in:** on `input_audio_buffer.speech_started`, the bridge sends Twilio `clear` (drop Go's queued audio) and the model `conversation.item.truncate` at the milliseconds already played (Twilio's media timestamps).
6. Go's lines (`response.output_audio_transcript.done`) and the business's lines (`conversation.item.input_audio_transcription.completed`) go to `hooks.line`.
7. `report_outcome` is answered with "Noted. Now thank them and say goodbye.", and the goodbye response's end hangs up 2.5 s later (15 s at the latest).
8. At 3:40 the model is told to wrap up; at 4:00 the bridge hangs up whatever happens. A dropped model socket hangs up too.

Event names are the GA realtime ones, with the older beta names (`response.audio.delta`, `response.audio_transcript.done`) accepted as well; the day-one check (Task 14) confirms which the account gets. The model id is `gpt-realtime-2.1` because it has the "caller started speaking" event barge-in needs (`gpt-live-1` does not).

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/calls/bridge.test.ts
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { manualTime, waitFor } from '../proactive/fakes.js';
import { attachBridge, type EndReason } from './bridge.js';
import type { CallBrief, ReportedOutcome } from './realtime.js';
import type { CallLine } from './store.js';

/** G.711 μ-law, as Twilio sends it: 160 bytes per 20 ms frame at 8 kHz. */
function muLaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  let s = Math.min(Math.abs(sample), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  s = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return s;
}
function toneFrame(n: number): string {
  const buf = Buffer.alloc(160);
  for (let i = 0; i < 160; i += 1) buf[i] = muLaw(Math.round(8000 * Math.sin((2 * Math.PI * 440 * (n * 160 + i)) / 8000)));
  return buf.toString('base64');
}

const brief: CallBrief = { business: 'Villa Sol', goal: 'Ask if we can check in at 10 am on 6 Nov', factsAllowed: ['Group of five', 'Staying 6 to 9 November'], forWhom: 'a group of 5 friends travelling together' };
const startFrame = (token: string) => ({ event: 'start', sequenceNumber: '1', streamSid: 'MZ1', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { token }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } });

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function setup() {
  const time = manualTime('2026-10-06T10:00:00Z');
  const model = new WebSocketServer({ port: 0 });
  const modelGot: Array<Record<string, any>> = [];
  let modelSocket: WebSocket | null = null;
  model.on('connection', (ws) => {
    modelSocket = ws;
    ws.on('message', (data) => modelGot.push(JSON.parse(data.toString()) as Record<string, any>));
  });
  const modelUrl = `ws://127.0.0.1:${(model.address() as AddressInfo).port}`;
  const seen = { talking: [] as string[], lines: [] as CallLine[], outcomes: [] as ReportedOutcome[], ended: [] as EndReason[], hangUps: [] as string[] };

  const bridgeServer = new WebSocketServer({ port: 0 });
  bridgeServer.on('connection', (ws) =>
    attachBridge(ws, 'call_1', {
      claim: async (_id, token) => (token === 'tok' ? brief : null),
      openRealtime: () => new WebSocket(modelUrl),
      hangUp: async (id) => { seen.hangUps.push(id); },
      hooks: {
        talking: async (id) => { seen.talking.push(id); },
        line: (_id, line) => { seen.lines.push(line); },
        outcome: (_id, o) => { seen.outcomes.push(o); },
        ended: async (_id, reason) => { seen.ended.push(reason); },
      },
      schedule: time.schedule,
      capMs: 240_000,
      session: { model: 'gpt-realtime-2.1', voice: 'marin', transcribeModel: 'gpt-4o-mini-transcribe' },
      log: { warn: () => {} },
    }),
  );
  const twilio = new WebSocket(`ws://127.0.0.1:${(bridgeServer.address() as AddressInfo).port}`);
  const twilioGot: Array<Record<string, any>> = [];
  let closedWith: number | null = null;
  twilio.on('message', (data) => twilioGot.push(JSON.parse(data.toString()) as Record<string, any>));
  twilio.on('close', (code) => { closedWith = code; });
  await new Promise((resolve) => twilio.once('open', resolve));
  cleanups.push(() => { twilio.terminate(); model.close(); bridgeServer.close(); });
  return {
    time, seen, modelGot, twilioGot,
    send: (frame: object) => twilio.send(JSON.stringify(frame)),
    fromModel: (event: object) => modelSocket?.send(JSON.stringify(event)),
    modelSocket: () => modelSocket,
    closedWith: () => closedWith,
  };
}

describe('attachBridge', () => {
  it('bridges μ-law both ways, clears on barge-in, keeps the transcript and hangs up after the goodbye', async () => {
    const s = await setup();
    s.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    s.send(startFrame('tok'));
    await waitFor(() => s.seen.talking.length === 1 && s.modelGot.some((e) => e.type === 'session.update'));
    const update = s.modelGot.find((e) => e.type === 'session.update')!;
    expect(update.session.audio.input.format).toEqual({ type: 'audio/pcmu' });
    expect(update.session.audio.output.format).toEqual({ type: 'audio/pcmu' });
    expect(update.session.audio.input.transcription).toEqual({ model: 'gpt-4o-mini-transcribe' });
    expect(update.session.tools[0].name).toBe('report_outcome');
    expect(update.session.instructions).toContain('an AI assistant');
    expect(update.session.instructions).toContain('Never pay');
    expect(update.session.instructions).not.toMatch(/openai|gpt/i);

    s.fromModel({ type: 'response.created', response: { id: 'resp_1' } });
    s.fromModel({ type: 'response.output_audio.delta', response_id: 'resp_1', item_id: 'item_1', delta: toneFrame(0) });
    await waitFor(() => s.twilioGot.some((f) => f.event === 'media'));
    expect(s.twilioGot.find((f) => f.event === 'media')).toEqual({ event: 'media', streamSid: 'MZ1', media: { payload: toneFrame(0) } });

    const frames = [10, 11, 12].map(toneFrame);
    frames.forEach((payload, i) => s.send({ event: 'media', sequenceNumber: String(i + 2), streamSid: 'MZ1', media: { track: 'inbound', chunk: String(i + 1), timestamp: String(i * 20), payload } }));
    await waitFor(() => s.modelGot.filter((e) => e.type === 'input_audio_buffer.append').length === 3);
    expect(s.modelGot.filter((e) => e.type === 'input_audio_buffer.append').map((e) => e.audio)).toEqual(frames);

    s.fromModel({ type: 'input_audio_buffer.speech_started', audio_start_ms: 40, item_id: 'item_2' });
    await waitFor(() => s.twilioGot.some((f) => f.event === 'clear') && s.modelGot.some((e) => e.type === 'conversation.item.truncate'));
    expect(s.twilioGot.find((f) => f.event === 'clear')).toEqual({ event: 'clear', streamSid: 'MZ1' });
    expect(s.modelGot.find((e) => e.type === 'conversation.item.truncate')).toMatchObject({ item_id: 'item_1', content_index: 0, audio_end_ms: 40 });

    s.fromModel({ type: 'response.output_audio_transcript.done', item_id: 'item_1', transcript: 'Hi, this is Go, an AI assistant calling for a group of five.' });
    s.fromModel({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_2', transcript: 'Yes, check-in at 10 is fine.' });
    await waitFor(() => s.seen.lines.length === 2);
    expect(s.seen.lines).toEqual([
      { who: 'go', text: 'Hi, this is Go, an AI assistant calling for a group of five.' },
      { who: 'them', text: 'Yes, check-in at 10 is fine.' },
    ]);

    s.fromModel({
      type: 'response.function_call_arguments.done', response_id: 'resp_3', item_id: 'item_3', call_id: 'fc_1', name: 'report_outcome',
      arguments: JSON.stringify({ outcome: 'Check-in at 10 am is fine.', answered: true, record: { kind: 'agreed', text: 'Early check-in at 10 am at Villa Sol is fine' } }),
    });
    await waitFor(() => s.seen.outcomes.length === 1 && s.modelGot.some((e) => e.type === 'conversation.item.create'));
    expect(s.modelGot.find((e) => e.type === 'conversation.item.create')).toMatchObject({ item: { type: 'function_call_output', call_id: 'fc_1' } });
    expect(s.seen.outcomes[0]).toMatchObject({ outcome: 'Check-in at 10 am is fine.', record: { kind: 'agreed' } });

    s.fromModel({ type: 'response.done', response: { id: 'resp_3' } });
    s.fromModel({ type: 'response.created', response: { id: 'resp_4' } });
    s.fromModel({ type: 'response.done', response: { id: 'resp_4' } });
    await waitFor(() => s.time.pending() === 5); // greet, wrap-up, cap, report fallback, goodbye
    s.time.advance(2_500);
    expect(s.seen.hangUps).toEqual(['call_1']);
    await waitFor(() => s.seen.ended.length === 1);
    expect(s.seen.ended).toEqual(['hangup']);
  });

  it('refuses a media connection with the wrong token and ends nothing', async () => {
    const s = await setup();
    s.send(startFrame('forged'));
    await waitFor(() => s.closedWith() !== null);
    expect(s.closedWith()).toBe(1008);
    expect(s.seen.talking).toEqual([]);
    expect(s.seen.ended).toEqual([]);
    expect(s.modelSocket()).toBeNull();
  });

  it('speaks first when nobody says hello, wraps up near the cap and hangs up at 4 minutes', async () => {
    const s = await setup();
    s.send(startFrame('tok'));
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.update'));
    s.time.advance(4_000);
    await waitFor(() => s.modelGot.some((e) => e.type === 'response.create'));
    s.time.advance(240_000 - 20_000 - 4_000);
    await waitFor(() => s.modelGot.some((e) => e.type === 'conversation.item.create'));
    expect(JSON.stringify(s.modelGot.find((e) => e.type === 'conversation.item.create'))).toContain('Time is nearly up');
    s.time.advance(20_000);
    expect(s.seen.hangUps).toEqual(['call_1']);
    await waitFor(() => s.seen.ended.length === 1);
    expect(s.seen.ended).toEqual(['cap']);
  });

  it('ends when the business hangs up, without hanging up again', async () => {
    const s = await setup();
    s.send(startFrame('tok'));
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.update'));
    s.send({ event: 'stop', streamSid: 'MZ1', stop: { callSid: 'CA1' } });
    await waitFor(() => s.seen.ended.length === 1);
    expect(s.seen.ended).toEqual(['hangup']);
    expect(s.seen.hangUps).toEqual([]);
  });

  it('hangs up when the voice model drops', async () => {
    const s = await setup();
    s.send(startFrame('tok'));
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.update'));
    s.modelSocket()?.terminate();
    await waitFor(() => s.seen.ended.length === 1);
    expect(s.seen.ended).toEqual(['error']);
    expect(s.seen.hangUps).toEqual(['call_1']);
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the modules do not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/brain/src/calls/realtime.ts
// What the voice model is told on a call, the session it runs with, and the one tool it has.
import WebSocket from 'ws';
import { z } from 'zod';

export interface CallBrief { business: string; goal: string; factsAllowed: string[]; forWhom: string }
export interface SessionSettings { model: string; voice: string; transcribeModel: string }

export function callInstructions(b: CallBrief): string {
  const facts = b.factsAllowed.length > 0 ? b.factsAllowed.map((f) => `- ${f}`).join('\n') : '- Nothing beyond the question itself.';
  return [
    `You are Go, an AI assistant, on a phone call to ${b.business} on behalf of ${b.forWhom}.`,
    `When they answer, say first: "Hi, this is Go, an AI assistant calling for ${b.forWhom}." Then ask your question.`,
    `Your goal: ${b.goal}`,
    'Facts you may share if they help, and nothing else about the group:',
    facts,
    'Rules:',
    '- Never pay, never agree to pay, and never give card, bank, UPI or login details. If they ask for payment, say the group will pay separately.',
    '- Never share phone numbers, emails or anything not listed above.',
    '- Never say which company made you or which model you are. You are Go.',
    '- Be brief and polite. Short sentences. Speak English; if they answer in Hindi, speak Hindi.',
    '- If they ask you to hold, wait quietly.',
    '- As soon as you have the answer, or it is clear you cannot get it, call report_outcome with the outcome in one or two plain sentences. Then thank them and say goodbye.',
  ].join('\n');
}

export const REPORT_OUTCOME_TOOL = {
  type: 'function',
  name: 'report_outcome',
  description: 'Report what came of the call, once, before saying goodbye.',
  parameters: {
    type: 'object',
    properties: {
      outcome: { type: 'string', description: 'What they said, in one or two plain sentences for the group.' },
      answered: { type: 'boolean', description: 'True when the business answered the question.' },
      record: {
        type: ['object', 'null'],
        description: 'Set when the answer settles something the group should keep (agreed) or still decide (open).',
        properties: {
          kind: { type: 'string', enum: ['agreed', 'open'] },
          text: { type: 'string', description: 'One short line for the trip record.' },
        },
        required: ['kind', 'text'],
      },
    },
    required: ['outcome', 'answered'],
  },
} as const;

export const ReportedOutcome = z.object({
  outcome: z.string().min(1).max(500),
  answered: z.boolean(),
  record: z.object({ kind: z.enum(['agreed', 'open']), text: z.string().min(1).max(200) }).nullable().optional(),
});
export type ReportedOutcome = z.infer<typeof ReportedOutcome>;

export function sessionUpdate(b: CallBrief, o: SessionSettings): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: o.model,
      instructions: callInstructions(b),
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          transcription: { model: o.transcribeModel },
          turn_detection: { type: 'server_vad', silence_duration_ms: 500 },
        },
        output: { format: { type: 'audio/pcmu' }, voice: o.voice },
      },
      tools: [REPORT_OUTCOME_TOOL],
      tool_choice: 'auto',
    },
  };
}

/** A plain WebSocket to the realtime API (no SDK: the repo pins an older SDK for the copied agent loop). */
export function openRealtime(o: { url: string; model: string; apiKey: string }): WebSocket {
  return new WebSocket(`${o.url}?model=${encodeURIComponent(o.model)}`, { headers: { Authorization: `Bearer ${o.apiKey}` } });
}
```

```ts
// apps/brain/src/calls/bridge.ts
// The live call: Twilio's media socket on one side, the realtime voice model on the other. μ-law audio
// passes through untouched both ways. Lines become the transcript; report_outcome ends the call politely;
// the cap ends it regardless.
import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';
import type { Schedule } from '../proactive/clock.js';
import { ReportedOutcome, sessionUpdate, type CallBrief, type SessionSettings } from './realtime.js';
import type { CallLine } from './store.js';

export type EndReason = 'hangup' | 'cap' | 'error';

export interface BridgeHooks {
  talking(callId: string): Promise<void>;
  line(callId: string, line: CallLine): void;
  outcome(callId: string, o: ReportedOutcome): void;
  ended(callId: string, reason: EndReason): Promise<void>;
}

export interface BridgeDeps {
  /** Checks the one-use token; null refuses the connection. */
  claim(callId: string, token: string): Promise<CallBrief | null>;
  openRealtime(): WebSocket;
  hangUp(callId: string): Promise<void>;
  hooks: BridgeHooks;
  schedule: Schedule;
  capMs: number;
  session: SessionSettings;
  log: { warn(obj: object, msg: string): void };
}

export const GREET_AFTER_MS = 4_000;
export const WRAP_UP_BEFORE_MS = 20_000;
export const HANG_UP_AFTER_GOODBYE_MS = 2_500;
export const HANG_UP_AFTER_REPORT_MS = 15_000;
const WRAP_UP = 'Time is nearly up. Wrap up now: call report_outcome, then thank them and say goodbye.';

const TwilioFrame = z.object({
  event: z.string(),
  start: z
    .object({ streamSid: z.string(), callSid: z.string().optional(), customParameters: z.record(z.string(), z.string()).optional() })
    .optional(),
  media: z.object({ payload: z.string(), timestamp: z.union([z.string(), z.number()]).optional() }).optional(),
});

export function attachBridge(twilio: WebSocket, callId: string, d: BridgeDeps): void {
  let rt: WebSocket | null = null;
  let streamSid = '';
  let started = false;
  let ended = false;
  let hangingUp = false;
  let latestTs = 0;
  let responseStartTs: number | null = null;
  let lastItem: string | null = null;
  let heardThem = false;
  let goSpoke = false;
  let reported = false;
  let goodbyeId: string | null = null;
  const cancels: Array<() => void> = [];

  const toTwilio = (frame: object): void => {
    if (twilio.readyState === WebSocket.OPEN) twilio.send(JSON.stringify(frame));
  };
  const toModel = (event: object): void => {
    if (rt && rt.readyState === WebSocket.OPEN) rt.send(JSON.stringify(event));
  };

  async function end(reason: EndReason): Promise<void> {
    if (ended) return;
    ended = true;
    for (const cancel of cancels) cancel();
    if (rt && rt.readyState !== WebSocket.CLOSED) rt.close();
    if (twilio.readyState === WebSocket.OPEN) twilio.close();
    if (started) await d.hooks.ended(callId, reason);
  }
  const finish = (reason: EndReason): void => {
    end(reason).catch((err: unknown) => d.log.warn({ err, callId }, 'calls: closing the call failed'));
  };
  const hangUp = (reason: EndReason): void => {
    if (hangingUp) return;
    hangingUp = true;
    d.hangUp(callId).catch((err: unknown) => d.log.warn({ err, callId }, 'calls: hanging up failed'));
    finish(reason);
  };

  function onModel(ev: Record<string, unknown>): void {
    const str = (k: string): string => (typeof ev[k] === 'string' ? (ev[k] as string) : '');
    const responseId = (): string => {
      const r = ev.response as { id?: unknown } | undefined;
      return typeof r?.id === 'string' ? r.id : '';
    };
    switch (str('type')) {
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const item = str('item_id');
        if (item && item !== lastItem) {
          lastItem = item;
          responseStartTs = latestTs;
        }
        goSpoke = true;
        toTwilio({ event: 'media', streamSid, media: { payload: str('delta') } });
        return;
      }
      case 'input_audio_buffer.speech_started': {
        heardThem = true;
        if (lastItem !== null && responseStartTs !== null) {
          toTwilio({ event: 'clear', streamSid });
          toModel({ type: 'conversation.item.truncate', item_id: lastItem, content_index: 0, audio_end_ms: Math.max(0, latestTs - responseStartTs) });
        }
        lastItem = null;
        responseStartTs = null;
        return;
      }
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const text = str('transcript').trim();
        if (text) d.hooks.line(callId, { who: 'go', text });
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = str('transcript').trim();
        if (text) d.hooks.line(callId, { who: 'them', text });
        return;
      }
      case 'response.function_call_arguments.done': {
        if (str('name') !== 'report_outcome' || reported) return;
        let args: unknown = null;
        try {
          args = JSON.parse(str('arguments'));
        } catch {
          args = null;
        }
        const parsed = ReportedOutcome.safeParse(args);
        toModel({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: str('call_id'),
            output: parsed.success ? 'Noted. Now thank them and say goodbye.' : 'That outcome could not be read. Call report_outcome again with a short outcome.',
          },
        });
        toModel({ type: 'response.create' });
        if (parsed.success) {
          reported = true;
          d.hooks.outcome(callId, parsed.data);
          cancels.push(d.schedule(() => hangUp('hangup'), HANG_UP_AFTER_REPORT_MS));
        }
        return;
      }
      case 'response.created':
        if (reported && goodbyeId === null) goodbyeId = responseId();
        return;
      case 'response.done':
        if (goodbyeId !== null && responseId() === goodbyeId) cancels.push(d.schedule(() => hangUp('hangup'), HANG_UP_AFTER_GOODBYE_MS));
        return;
      case 'error':
        d.log.warn({ callId, error: ev.error }, 'calls: the voice model reported an error');
        return;
      default:
        return;
    }
  }

  function openModel(brief: CallBrief): void {
    const socket = d.openRealtime();
    rt = socket;
    socket.on('open', () => toModel(sessionUpdate(brief, d.session)));
    socket.on('message', (data: RawData) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      onModel(ev);
    });
    socket.on('close', () => {
      if (!ended) hangUp('error');
    });
    socket.on('error', (err: Error) => d.log.warn({ err, callId }, 'calls: voice model socket error'));
  }

  async function onTwilio(data: RawData): Promise<void> {
    let frame: z.infer<typeof TwilioFrame>;
    try {
      frame = TwilioFrame.parse(JSON.parse(data.toString()));
    } catch {
      return;
    }
    if (frame.event === 'start' && frame.start && !started) {
      const brief = await d.claim(callId, frame.start.customParameters?.token ?? '');
      if (!brief) {
        twilio.close(1008, 'refused');
        return;
      }
      started = true;
      streamSid = frame.start.streamSid;
      await d.hooks.talking(callId);
      openModel(brief);
      cancels.push(d.schedule(() => {
        if (!heardThem && !goSpoke) toModel({ type: 'response.create' });
      }, GREET_AFTER_MS));
      cancels.push(d.schedule(() => {
        toModel({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: WRAP_UP }] } });
        toModel({ type: 'response.create' });
      }, d.capMs - WRAP_UP_BEFORE_MS));
      cancels.push(d.schedule(() => hangUp('cap'), d.capMs));
      return;
    }
    if (!started) return;
    if (frame.event === 'media' && frame.media) {
      if (frame.media.timestamp !== undefined) latestTs = Number(frame.media.timestamp);
      toModel({ type: 'input_audio_buffer.append', audio: frame.media.payload });
      return;
    }
    if (frame.event === 'stop') finish('hangup');
  }

  twilio.on('message', (data: RawData) => {
    onTwilio(data).catch((err: unknown) => d.log.warn({ err, callId }, 'calls: media frame failed'));
  });
  twilio.on('close', () => finish('hangup'));
  twilio.on('error', (err: Error) => d.log.warn({ err, callId }, 'calls: media socket error'));
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/calls/realtime.ts apps/brain/src/calls/bridge.ts apps/brain/src/calls/bridge.test.ts
git commit -m "feat(calls): the live call, Twilio's mu-law straight to the voice model and back, with barge-in and a 4 minute cap

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `bridge.test.ts` passes (audio both ways, barge-in, transcript, outcome, wrong token, cap, hang-ups); earlier tests stay green.

### Task 12: The call service and `call_business` (window, dial, live card, outcome, failures)

**Files:**
- Create: `apps/brain/src/calls/card-updater.ts`
- Create: `apps/brain/src/calls/service.ts`
- Create: `apps/brain/src/calls/tool.ts`
- Test: `apps/brain/src/calls/card-updater.test.ts`
- Test: `apps/brain/src/calls/service.test.ts`

**Interfaces:**
- Consumes: `Schedule` (Task 1); `clip`, `plain` (Task 5); `CallsConfig`, `findCallee`, `loadCallsConfig`, `mediaUrl`, `statusUrl`, `maskPhone`, `CALL_WINDOW_MS`, `CARD_GAP_MS`, `RING_TIMEOUT_S`, `TWILIO_TIME_LIMIT_S` (Task 9); `saysStop` (Task 9); `CallStore`, `CallRow`, `CallLine` (Task 9); `TwilioClient`, `streamTwiml`, `twilioOutcome` (Task 10); `CallBrief`, `ReportedOutcome` (Task 11); `EndReason` (Task 11); `ServerLink` (P1); `Switches.get('CALLS_MODE')` (P1); `Packs.get`, `TripPack` (P1); `Message`, `CardTapParams`, `CardTapResult` (P1); `QuickTool`, `TurnCtx` (P1); `CallCard` (`@go/contract`).
- Produces:
  - `card-updater.ts`: `class CardUpdater<C> { constructor(send: (card: C) => Promise<void>, o: { now; schedule; minGapMs; log }); update(card: C): void; final(card: C): Promise<void> }`.
  - `service.ts`: `type CallCardIn = z.input<typeof CallCard>`; `STOP_LINE`; `ORPHAN_AFTER_MS = 15_000`; `NO_MEDIA_AFTER_MS = 90_000`; `CLOSE_OUT_AFTER_MS = 10_000`; `interface CallRequest { business; phone?: string | undefined; goal; announce: string; factsAllowed: string[] }`; `type CallRequestResult`; `interface CallServiceDeps { store; link; packs; switches; config; twilio: TwilioClient | null; now; schedule; log }`; `forWhom(pack): string`; `class CallService` with `mode()`, `callable(): string[]`, `liveFor(tripId)`, `recentlyCancelled(tripId)`, `request(tripId, pack, r)`, `onMessage(msg, pack)`, `tick()`, `claim(callId, token)`, `talking(callId)`, `line(callId, line)`, `outcome(callId, o)`, `ended(callId, reason)`, `hangUp(callId)`, `stopTap(tap)`, `onTwilioStatus(callId, status)`, `fail(callId, why)`.
  - `tool.ts`: `CallBusinessArgs` (zod) and its type; `callTool(service: CallService): QuickTool<CallBusinessArgs>` (name `call_business`).

The room behaviour follows spec §14 and the guide's flow (`docs/guide/09-flows.md` §5) exactly:
1. `call_business` checks the switch (`CALLS_MODE` must read `allowlist`), the settings, the allowlist (by number, or by a listed name), refuses card, bank, OTP or login words and long digit runs in the goal or the facts, and refuses a second live call for the trip. Then it posts one line, the composer's own words plus "Say stop in the next 30 seconds if you'd rather I didn't.", and stores the call with `dial_at = now + 30 s`. The call card is posted when dialing starts, as the guide's flow does.
2. In the window, any person's message after Go's line that says stop (Task 9's words), or a bare "no"/"nahi" in reply to Go's line, cancels the call; Go replies "Okay, I won't call Villa Sol." The `calls` "right now" block (Task 13) tells the composer it already replied.
3. At 30 s the tick reads the switch again (flipped to `off` means "Calls are switched off right now, so I didn't call Villa Sol."), posts the call card (`dialing`, a "Stop the call" button), stores the token's hash and places the Twilio call.
4. While talking, the card is replaced at most every 3 s with the latest line (`last_line`); the final card (state `ended`, `outcome`, `transcript`, `ended_at`, no buttons) always lands.
5. The end: the outcome as a reply to the person who asked; if the outcome settles something, `add_record_line` with `proof` = the call card's message (decision: P6 writes the line directly instead of going through P2's `record` tool, because the proof is Go's own card message, not a person's message, and the call ends outside any composer turn). An `open` line asks the organizer and names them.
6. Failures: busy, no answer, failed or a Twilio refusal turn the card to `failed` and say one line. The tick closes out a call left talking by a restart (after 15 s), a call that never got media (after 90 s), and any ended call whose close-out did not finish.

Every write uses `request_id = go_<call_id>_<step>`, so a re-run after a crash repeats nothing.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/brain/src/calls/card-updater.test.ts
import { describe, expect, it } from 'vitest';
import { manualTime } from '../proactive/fakes.js';
import { CardUpdater } from './card-updater.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('CardUpdater', () => {
  it('sends at once, then at most once every 3 s with the latest card', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const sent: string[] = [];
    const u = new CardUpdater<string>(async (c) => { sent.push(c); }, { now: time.now, schedule: time.schedule, minGapMs: 3000, log: { warn: () => {} } });
    u.update('a');
    await flush();
    u.update('b');
    u.update('c');
    await flush();
    expect(sent).toEqual(['a']);
    time.advance(2999);
    await flush();
    expect(sent).toEqual(['a']);
    time.advance(1);
    await flush();
    expect(sent).toEqual(['a', 'c']);
  });

  it('always sends the final card, dropping a pending one', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const sent: string[] = [];
    const u = new CardUpdater<string>(async (c) => { sent.push(c); }, { now: time.now, schedule: time.schedule, minGapMs: 3000, log: { warn: () => {} } });
    u.update('a');
    await flush();
    u.update('b');
    await u.final('end');
    u.update('late');
    time.advance(10_000);
    await flush();
    expect(sent).toEqual(['a', 'end']);
  });

  it('keeps going after a failed update', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const sent: string[] = [];
    let fail = true;
    const u = new CardUpdater<string>(async (c) => {
      if (fail) { fail = false; throw new Error('server busy'); }
      sent.push(c);
    }, { now: time.now, schedule: time.schedule, minGapMs: 3000, log: { warn: () => {} } });
    u.update('a');
    await flush();
    u.update('b');
    time.advance(3000);
    await flush();
    expect(sent).toEqual(['b']);
  });
});
```

```ts
// apps/brain/src/calls/service.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import { fakeLink, fakePacks, goaPack, goaTrip, manualTime, msg, waitFor } from '../proactive/fakes.js';
import type { TripPack } from '../trips/pack.js';
import { loadCallsConfig } from './config.js';
import { CallService, STOP_LINE } from './service.js';
import { CallStore } from './store.js';
import { TwilioError, type CreateCall, type TwilioClient } from './twilio.js';

const env = {
  GO_PUBLIC_URL: 'https://brain.test',
  TWILIO_ACCOUNT_SID: 'AC_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  TWILIO_FROM: '+14155550100',
  OPENAI_API_KEY: 'sk-test',
  CALLS_ALLOWLIST: 'Villa Sol=+919800000001',
};
const req = {
  business: 'Villa Sol',
  goal: 'Ask if we can check in at 10 am on 6 Nov',
  announce: "I'll call Villa Sol about early check-in — 10 am on the 6th.",
  factsAllowed: ['Group of five', 'Staying 6 to 9 November'],
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

let db: Awaited<ReturnType<typeof withSchema>>;
let store: CallStore;
beforeAll(async () => {
  db = await withSchema();
  store = new CallStore(db.pool);
});
afterAll(async () => {
  await db.drop();
});

function make(tripId: string, o: { mode?: string; twilioFails?: boolean } = {}) {
  const time = manualTime('2026-10-06T10:00:00Z');
  const link = fakeLink();
  const values: Record<string, string> = { CALLS_MODE: o.mode ?? 'allowlist' };
  const twilioCalls: CreateCall[] = [];
  const hangUps: string[] = [];
  const twilio: TwilioClient = {
    createCall: async (p) => {
      twilioCalls.push(p);
      if (o.twilioFails) throw new TwilioError(400, 21215, 'Account not authorized to call +919800000001');
      return { sid: `CA_${tripId}` };
    },
    hangUp: async (sid) => { hangUps.push(sid); },
  };
  const pack: TripPack = goaPack({
    trip: goaTrip({ trip_id: tripId }),
    messages: [msg({ id: 'm_300', seq: 300, by: 'p_arjun', text: '@Go can you ask Villa Sol if we can check in at 10?', mentionsGo: true })],
  });
  const service = new CallService({
    store, link, packs: fakePacks(pack), switches: { get: (n: string) => values[n] ?? '' }, config: loadCallsConfig(env), twilio,
    now: time.now, schedule: time.schedule, log: { info: () => {}, warn: () => {} },
  });
  return { time, link, values, twilioCalls, hangUps, service, pack };
}

async function dialed(tripId: string) {
  const m = make(tripId);
  const r = await m.service.request(tripId, m.pack, req);
  if (!('ok' in r)) throw new Error('refused');
  m.time.advance(30_000);
  await m.service.tick();
  const token = /name="token" value="([^"]+)"/.exec(m.twilioCalls[0]?.twiml ?? '')?.[1] ?? '';
  return { ...m, callId: r.callId, token };
}

describe('request', () => {
  it('refuses when calls are off', async () => {
    const m = make('t_off', { mode: 'off' });
    expect(await m.service.request('t_off', m.pack, req)).toEqual({ refused: 'Calls are switched off right now.' });
    expect(m.link.calls).toHaveLength(0);
  });

  it('refuses a number or a business that is not on the allowlist', async () => {
    const m = make('t_list');
    expect(await m.service.request('t_list', m.pack, { ...req, phone: '+919999999999' })).toHaveProperty('refused');
    expect(await m.service.request('t_list', m.pack, { ...req, business: 'Casa Azul' })).toHaveProperty('refused');
    expect(m.link.calls).toHaveLength(0);
  });

  it('refuses card, bank and login details, so a call can never pay', async () => {
    const m = make('t_pay');
    expect(await m.service.request('t_pay', m.pack, { ...req, factsAllowed: ["Rahul's card 4111 1111 1111 1111"] })).toHaveProperty('refused');
    expect(await m.service.request('t_pay', m.pack, { ...req, goal: 'Pay the deposit by UPI' })).toHaveProperty('refused');
    expect(m.link.calls).toHaveLength(0);
  });

  it('says who and why with the stop line, waits 30 s, and allows one call at a time', async () => {
    const m = make('t_announce');
    const r = await m.service.request('t_announce', m.pack, req);
    expect(r).toMatchObject({ ok: true, dialAt: '2026-10-06T10:00:30.000Z' });
    const callId = 'callId' in r ? r.callId : '';
    const [announce] = m.link.of('post_message');
    expect(announce).toMatchObject({ request_id: `go_${callId}_announce`, trip_id: 't_announce', text: `I'll call Villa Sol about early check-in, 10 am on the 6th. ${STOP_LINE}` });
    expect(String(announce?.text)).not.toContain('—');
    expect(m.twilioCalls).toHaveLength(0);
    expect(await m.service.request('t_announce', m.pack, req)).toEqual({ refused: 'Go is already on a call for this trip. One at a time.' });
  });
});

describe('the stop window', () => {
  it('a Hinglish stop cancels the call before it dials', async () => {
    const m = make('t_ruko');
    await m.service.request('t_ruko', m.pack, req);
    await m.service.onMessage(msg({ id: 'm_stop', seq: 1002, by: 'p_priya', text: 'ruk jao, mat karo abhi' }), m.pack);
    expect(m.link.of('post_message').at(-1)).toMatchObject({ text: "Okay, I won't call Villa Sol.", reply_to: 'm_stop' });
    m.time.advance(30_000);
    await m.service.tick();
    expect(m.twilioCalls).toHaveLength(0);
  });

  it('takes a bare "nahi" only as a reply to the call line', async () => {
    const m = make('t_nahi');
    await m.service.request('t_nahi', m.pack, req);
    await m.service.onMessage(msg({ seq: 1002, by: 'p_kabir', text: 'nahi' }), m.pack);
    expect((await m.service.liveFor('t_nahi'))?.state).toBe('waiting');
    await m.service.onMessage(msg({ seq: 1003, by: 'p_kabir', text: 'nahi', replyTo: 'm_go_1' }), m.pack);
    expect(await m.service.liveFor('t_nahi')).toBeNull();
  });

  it('a stop said before Go spoke does not count', async () => {
    const m = make('t_before');
    await m.service.request('t_before', m.pack, req);
    await m.service.onMessage(msg({ seq: 900, by: 'p_priya', text: 'stop' }), m.pack);
    expect((await m.service.liveFor('t_before'))?.state).toBe('waiting');
  });

  it('switching calls off inside the window means no call', async () => {
    const m = make('t_flip');
    await m.service.request('t_flip', m.pack, req);
    m.values.CALLS_MODE = 'off';
    m.time.advance(30_000);
    await m.service.tick();
    expect(m.twilioCalls).toHaveLength(0);
    expect(m.link.of('post_message').at(-1)?.text).toBe("Calls are switched off right now, so I didn't call Villa Sol.");
  });
});

describe('dialing', () => {
  it('posts the dialing card and calls through Twilio with a one-use token', async () => {
    const m = await dialed('t_dial');
    const card = m.link.of('post_message').at(-1);
    expect(card).toMatchObject({ request_id: `go_${m.callId}_card`, card: { kind: 'call', call_id: m.callId, business: 'Villa Sol', state: 'dialing', actions: [{ action_id: 'stop', label: 'Stop the call', style: 'secondary' }] } });
    const call = m.twilioCalls[0]!;
    expect(call).toMatchObject({ to: '+919800000001', from: '+14155550100', statusCallback: `https://brain.test/calls/twilio/status/${m.callId}`, timeLimitS: 255, ringTimeoutS: 30 });
    expect(call.twiml).toContain(`<Stream url="wss://brain.test/calls/media/${m.callId}">`);
    expect(m.token.length).toBeGreaterThan(20);
    expect(await m.service.claim(m.callId, 'forged')).toBeNull();
    expect(await m.service.claim(m.callId, m.token)).toMatchObject({ business: 'Villa Sol', forWhom: 'a group of 5 friends travelling together' });
    expect(await m.service.claim(m.callId, m.token)).toBeNull();
  });

  it('turns a Twilio refusal into a failed card and one line', async () => {
    const m = make('t_refused', { twilioFails: true });
    await m.service.request('t_refused', m.pack, req);
    m.time.advance(30_000);
    await m.service.tick();
    expect(m.link.of('replace_card').at(-1)).toMatchObject({ card: { state: 'failed', outcome: "Couldn't connect the call." } });
    expect(m.link.of('post_message').at(-1)?.text).toBe("I couldn't get through to Villa Sol.");
  });
});

describe('a call that connects', () => {
  it('updates the card at most every 3 s, then lands the outcome in the chat and the record', async () => {
    const m = await dialed('t_live');
    await m.service.claim(m.callId, m.token);
    await m.service.talking(m.callId);
    await flush();
    expect(m.link.of('replace_card').at(-1)).toMatchObject({ card: { state: 'talking', started_at: '2026-10-06T10:00:30.000Z' } });
    m.service.line(m.callId, { who: 'go', text: 'Hi, this is Go, an AI assistant calling for a group of 5 friends.' });
    m.service.line(m.callId, { who: 'them', text: 'Yes, 10 am check-in is fine — and ₹2,000 off for the deposit this week.' });
    await flush();
    expect(m.link.of('replace_card')).toHaveLength(1);
    m.time.advance(3000);
    await flush();
    expect(m.link.of('replace_card')).toHaveLength(2);
    expect(m.link.of('replace_card').at(-1)).toMatchObject({ card: { state: 'talking', last_line: { who: 'them', text: 'Yes, 10 am check-in is fine, and ₹2,000 off for the deposit this week.' } } });

    m.service.outcome(m.callId, { outcome: '10 am check-in is fine. They offered ₹2,000 off if we pay the deposit this week.', answered: true, record: { kind: 'open', text: '₹2,000 off at Villa Sol if we pay the deposit this week?' } });
    await m.service.ended(m.callId, 'hangup');

    const final = m.link.of('replace_card').at(-1)?.card as Record<string, unknown>;
    expect(final).toMatchObject({ state: 'ended', outcome: '10 am check-in is fine. They offered ₹2,000 off if we pay the deposit this week.' });
    expect(final.transcript).toHaveLength(2);
    expect(final.actions).toBeUndefined();
    expect(m.link.of('post_message').at(-1)).toMatchObject({
      request_id: `go_${m.callId}_outcome`,
      text: '10 am check-in is fine. They offered ₹2,000 off if we pay the deposit this week. Rahul, want to decide on this?',
      reply_to: 'm_300',
      mentions: ['p_rahul'],
    });
    const row = await store.get(m.callId);
    expect(m.link.of('add_record_line').at(-1)).toEqual({
      request_id: `go_${m.callId}_record`,
      trip_id: 't_live',
      kind: 'open',
      text: '₹2,000 off at Villa Sol if we pay the deposit this week?',
      proof: [{ message_id: row?.cardMessageId }],
      person_ids: ['p_rahul'],
    });
    expect(row).toMatchObject({ state: 'ended', reported: true });
    expect(row?.closedOutAt).not.toBeNull();
  });

  it('says once that nobody picked up', async () => {
    const m = await dialed('t_noanswer');
    await m.service.onTwilioStatus(m.callId, 'no-answer');
    await m.service.onTwilioStatus(m.callId, 'no-answer');
    expect(m.link.of('replace_card').at(-1)).toMatchObject({ card: { state: 'failed', outcome: 'Nobody picked up.' } });
    expect(m.link.of('post_message').filter((p) => p.text === "Villa Sol didn't pick up. Want me to try again later?")).toHaveLength(1);
  });

  it('hangs up on the Stop button, and refuses Stop once the call has ended', async () => {
    const m = await dialed('t_tap');
    const tap = { tap_id: 'tap_1', trip_id: 't_tap', card_id: `c_${m.callId}`, action_id: 'stop', person_id: 'p_priya' };
    expect(await m.service.stopTap(tap)).toEqual({ result: 'done', toast: 'Hanging up.' });
    await waitFor(() => m.link.of('post_message').some((p) => p.text === 'Okay, I hung up on Villa Sol.'));
    expect(m.hangUps).toEqual(['CA_t_tap']);
    expect(await m.service.stopTap({ ...tap, tap_id: 'tap_2' })).toEqual({ result: 'refused', toast: 'The call has already ended.' });
  });

  it('closes a call a restart left talking', async () => {
    const m = await dialed('t_orphan');
    await m.service.claim(m.callId, m.token);
    await store.talking(m.callId, m.time.now()); // talking in the table, but no live call in this process
    m.time.advance(16_000);
    await m.service.tick();
    expect((await store.get(m.callId))?.state).toBe('ended');
    expect(m.hangUps).toEqual(['CA_t_orphan']);
    expect(m.link.of('post_message').at(-1)?.text).toBe("I called Villa Sol but didn't get an answer to that. Want me to try again?");
  });
});
```

- [ ] **Step 2: Push the tests and see them fail**

Red is certain: the modules do not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/brain/src/calls/card-updater.ts
// Keeps a live card fresh without flooding the Server: at most one update every `minGapMs`, always the
// latest, in order, and the final card always lands.
import type { Schedule } from '../proactive/clock.js';

export class CardUpdater<C> {
  private latest: C | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;
  private cancelTimer: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly send: (card: C) => Promise<void>,
    private readonly o: { now: () => Date; schedule: Schedule; minGapMs: number; log: { warn(obj: object, msg: string): void } },
  ) {}

  update(card: C): void {
    if (this.stopped) return;
    this.latest = card;
    this.pump();
  }

  /** Drops anything pending, waits for an update in flight, then sends this card. */
  async final(card: C): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.latest = null;
    if (this.inFlight) await this.inFlight;
    await this.send(card);
  }

  private pump(): void {
    if (this.stopped || this.inFlight || this.cancelTimer || this.latest === null) return;
    const wait = this.lastSentAt + this.o.minGapMs - this.o.now().getTime();
    if (wait > 0) {
      this.cancelTimer = this.o.schedule(() => {
        this.cancelTimer = null;
        this.pump();
      }, wait);
      return;
    }
    const card = this.latest;
    this.latest = null;
    this.lastSentAt = this.o.now().getTime();
    this.inFlight = this.send(card)
      .catch((err: unknown) => this.o.log.warn({ err }, 'calls: a live card update failed'))
      .finally(() => {
        this.inFlight = null;
        this.pump();
      });
  }
}
```

```ts
// apps/brain/src/calls/service.ts
// The call service: the stop window, dialing, the live card, the outcome in the room and the record, and
// failures. Starting a call needs no thinking, so the 30 second window lives in the calls table and this
// service's tick, not on the desk.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CallCard } from '@go/contract';
import type { z } from 'zod';
import type { Switches } from '../admin/switches.js';
import type { CardTapParams, CardTapResult, Message } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { Schedule } from '../proactive/clock.js';
import { clip, plain } from '../proactive/words.js';
import type { Packs, TripPack } from '../trips/pack.js';
import type { EndReason } from './bridge.js';
import { CardUpdater } from './card-updater.js';
import {
  CALL_WINDOW_MS, CARD_GAP_MS, RING_TIMEOUT_S, TWILIO_TIME_LIMIT_S, findCallee, maskPhone, mediaUrl, statusUrl, type CallsConfig,
} from './config.js';
import type { CallBrief, ReportedOutcome } from './realtime.js';
import { saysStop } from './stop-words.js';
import type { CallLine, CallRow, CallStore } from './store.js';
import { streamTwiml, twilioOutcome, type TwilioClient } from './twilio.js';

export type CallCardIn = z.input<typeof CallCard>;
export const STOP_LINE = "Say stop in the next 30 seconds if you'd rather I didn't.";
export const ORPHAN_AFTER_MS = 15_000;
export const NO_MEDIA_AFTER_MS = 90_000;
export const CLOSE_OUT_AFTER_MS = 10_000;
const NOT_ON_A_CALL = /\b(card|cvv|otp|upi|pin|password|passcode|bank|account number|ifsc)\b/i;
const LONG_DIGITS = /\d[\d\s-]{10,}\d/;

type FailWhy = 'busy' | 'no_answer' | 'failed' | 'canceled';
const FAIL_OUTCOME: Readonly<Record<FailWhy, string>> = {
  busy: 'The line was busy.',
  no_answer: 'Nobody picked up.',
  failed: "Couldn't connect the call.",
  canceled: 'The call was cancelled before it connected.',
};
function failLine(business: string, why: string): string {
  switch (why) {
    case 'busy':
      return `${business}'s line was busy. Want me to try again in a bit?`;
    case 'no_answer':
      return `${business} didn't pick up. Want me to try again later?`;
    case 'canceled':
      return `The call to ${business} was cancelled before it connected.`;
    default:
      return `I couldn't get through to ${business}.`;
  }
}
function noOutcome(reason: string, stoppedBy: string | null): string {
  if (stoppedBy) return `Stopped by ${stoppedBy} before an answer.`;
  if (reason === 'stopped') return 'Stopped before an answer.';
  if (reason === 'cap') return 'The call ran out of time before an answer.';
  if (reason === 'dropped') return 'The call dropped before an answer.';
  return 'The call ended before an answer.';
}
const rid = (callId: string, step: string): string => `go_${callId}_${step}`;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function forWhom(pack: TripPack): string {
  const n = pack.trip.people.length;
  return n > 1 ? `a group of ${n} friends travelling together` : 'a traveller';
}

export interface CallRequest { business: string; phone?: string | undefined; goal: string; announce: string; factsAllowed: string[] }
export type CallRequestResult = { ok: true; callId: string; dialAt: string } | { refused: string };

export interface CallServiceDeps {
  store: CallStore;
  link: ServerLink;
  packs: Pick<Packs, 'get'>;
  switches: Pick<Switches, 'get'>;
  config: CallsConfig;
  twilio: TwilioClient | null;
  now: () => Date;
  schedule: Schedule;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

interface Live {
  row: CallRow;
  lines: CallLine[];
  outcome: ReportedOutcome | null;
  startedAt: Date;
  stoppedBy: string | null;
  updater: CardUpdater<CallCardIn>;
}

type CardState = 'dialing' | 'talking' | 'ended' | 'failed';

export class CallService {
  private readonly live = new Map<string, Live>();
  private ticking: Promise<void> | null = null;

  constructor(private readonly d: CallServiceDeps) {}

  mode(): 'off' | 'allowlist' {
    return this.d.switches.get('CALLS_MODE') === 'allowlist' ? 'allowlist' : 'off';
  }

  /** Names from the allowlist; numbers are never shown to the model. */
  callable(): string[] {
    return this.d.config.allowlist.flatMap((c) => (c.name ? [c.name] : []));
  }

  liveFor(tripId: string): Promise<CallRow | null> {
    return this.d.store.liveFor(tripId);
  }

  recentlyCancelled(tripId: string): Promise<CallRow | null> {
    return this.d.store.recentlyCancelled(tripId, new Date(this.d.now().getTime() - 120_000));
  }

  async request(tripId: string, pack: TripPack, r: CallRequest): Promise<CallRequestResult> {
    if (this.mode() === 'off') return { refused: 'Calls are switched off right now.' };
    if (!this.d.twilio || this.d.config.missing.length > 0) return { refused: 'Calls are not set up yet.' };
    if ([r.goal, ...r.factsAllowed].some((t) => NOT_ON_A_CALL.test(t) || LONG_DIGITS.test(t))) {
      return { refused: 'Calls never pay or share card, bank, OTP or login details. Leave those out.' };
    }
    const callee = findCallee(this.d.config, { business: r.business, phone: r.phone });
    if (!callee) return { refused: `${r.business} is not on the list of numbers Go may call this week.` };
    if (await this.d.store.liveFor(tripId)) return { refused: 'Go is already on a call for this trip. One at a time.' };

    const now = this.d.now();
    const callId = `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    let asker: Message | null = null;
    for (const m of pack.messages) if (m.author.kind === 'person' && m.mentions_go && !m.deleted) asker = m;
    const row = await this.d.store.create({
      callId,
      tripId,
      business: clip(plain(r.business), 80),
      phone: callee.phone,
      goal: clip(plain(r.goal), 160),
      factsAllowed: r.factsAllowed.map((f) => clip(f, 200)),
      forWhom: forWhom(pack),
      askedByPersonId: asker && asker.author.kind === 'person' ? asker.author.person_id : null,
      askedMessageId: asker ? asker.message_id : null,
      cardId: `c_${callId}`,
      dialAt: new Date(now.getTime() + CALL_WINDOW_MS),
    });
    try {
      const posted = await this.d.link.request('post_message', {
        request_id: rid(callId, 'announce'),
        trip_id: tripId,
        text: clip(`${plain(r.announce)} ${STOP_LINE}`, 2000),
      });
      await this.d.store.announced(callId, posted.message_id, posted.seq);
    } catch (err) {
      await this.d.store.cancel(callId, 'announce_failed', now);
      throw err;
    }
    this.d.log.info({ callId, tripId, to: maskPhone(callee.phone) }, 'calls: announced; dialing in 30 s unless someone says stop');
    this.d.schedule(() => {
      this.tick().catch((err: unknown) => this.d.log.warn({ err }, 'calls: tick failed'));
    }, CALL_WINDOW_MS);
    return { ok: true, callId, dialAt: row.dialAt.toISOString() };
  }

  /** In the window, a person's stop (or a bare "no" in reply to Go's line) cancels the call. */
  async onMessage(msg: Message, pack: TripPack): Promise<void> {
    if (msg.author.kind !== 'person') return;
    const call = await this.d.store.liveFor(pack.trip.trip_id);
    if (!call || call.state !== 'waiting' || call.announceSeq === null || msg.seq <= call.announceSeq) return;
    const repliesToLine = msg.reply_to != null && msg.reply_to === call.announceMessageId;
    if (!saysStop(msg.text, repliesToLine)) return;
    const cancelled = await this.d.store.cancel(call.callId, `stopped_by:${msg.author.person_id}`, this.d.now());
    if (!cancelled) return;
    await this.d.link.request('post_message', {
      request_id: rid(call.callId, 'cancel'),
      trip_id: call.tripId,
      text: `Okay, I won't call ${call.business}.`,
      reply_to: msg.message_id,
    });
  }

  /** Dials what is due, closes calls a restart stranded, finishes close-outs. One pass at a time. */
  tick(): Promise<void> {
    if (!this.ticking) this.ticking = this.tickOnce().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    const now = this.d.now();
    for (const row of await this.d.store.dueToDial(now)) await this.dial(row);
    for (const row of await this.d.store.inCall()) {
      if (this.live.has(row.callId)) continue;
      if (row.state === 'talking' && row.startedAt && now.getTime() - row.startedAt.getTime() > ORPHAN_AFTER_MS) await this.finish(row.callId, 'dropped');
      else if (row.state === 'dialing' && now.getTime() - row.dialAt.getTime() > NO_MEDIA_AFTER_MS) await this.fail(row.callId, 'no_answer');
    }
    for (const row of await this.d.store.toCloseOut(new Date(now.getTime() - CLOSE_OUT_AFTER_MS))) await this.closeOut(row, null);
  }

  private async dial(due: CallRow): Promise<void> {
    const twilio = this.d.twilio;
    const publicUrl = this.d.config.publicUrl;
    const from = this.d.config.from;
    if (this.mode() === 'off' || !twilio || !publicUrl || !from) {
      const c = await this.d.store.cancel(due.callId, 'calls_off', this.d.now());
      if (c) {
        await this.d.link.request('post_message', {
          request_id: rid(c.callId, 'off'),
          trip_id: c.tripId,
          text: `Calls are switched off right now, so I didn't call ${c.business}.`,
        });
      }
      return;
    }
    const row = await this.d.store.startDialing(due.callId);
    if (!row) return;
    const token = randomBytes(32).toString('base64url');
    const posted = await this.d.link.request('post_message', { request_id: rid(row.callId, 'card'), trip_id: row.tripId, card: this.card(row, { state: 'dialing' }) });
    await this.d.store.dialInfo(row.callId, { cardMessageId: posted.message_id, tokenHash: sha256(token) });
    try {
      const { sid } = await twilio.createCall({
        to: row.phone,
        from,
        twiml: streamTwiml({ url: mediaUrl(publicUrl, row.callId), token }),
        statusCallback: statusUrl(publicUrl, row.callId),
        timeLimitS: TWILIO_TIME_LIMIT_S,
        ringTimeoutS: RING_TIMEOUT_S,
      });
      await this.d.store.dialInfo(row.callId, { twilioSid: sid });
      this.d.log.info({ callId: row.callId, to: maskPhone(row.phone) }, 'calls: dialing');
    } catch (err) {
      this.d.log.warn({ err, callId: row.callId }, 'calls: Twilio refused the call');
      await this.fail(row.callId, 'failed');
    }
  }

  async claim(callId: string, token: string): Promise<CallBrief | null> {
    if (!token) return null;
    const row = await this.d.store.claimMedia(callId, sha256(token));
    return row ? { business: row.business, goal: row.goal, factsAllowed: row.factsAllowed, forWhom: row.forWhom } : null;
  }

  async talking(callId: string): Promise<void> {
    const now = this.d.now();
    const row = await this.d.store.talking(callId, now);
    if (!row) return;
    const updater = new CardUpdater<CallCardIn>((card) => this.replace(row.tripId, card), {
      now: this.d.now,
      schedule: this.d.schedule,
      minGapMs: CARD_GAP_MS,
      log: this.d.log,
    });
    this.live.set(callId, { row, lines: [], outcome: null, startedAt: now, stoppedBy: null, updater });
    updater.update(this.card(row, { state: 'talking', startedAt: now }));
  }

  line(callId: string, line: CallLine): void {
    const live = this.live.get(callId);
    if (!live) return;
    const l: CallLine = { who: line.who, text: clip(plain(line.text), 500) };
    live.lines.push(l);
    if (live.lines.length > 300) live.lines.shift();
    live.updater.update(this.card(live.row, { state: 'talking', startedAt: live.startedAt, lastLine: l }));
  }

  outcome(callId: string, o: ReportedOutcome): void {
    const live = this.live.get(callId);
    if (live) live.outcome = o;
  }

  async ended(callId: string, reason: EndReason): Promise<void> {
    await this.finish(callId, reason);
  }

  async hangUp(callId: string): Promise<void> {
    const row = await this.d.store.get(callId);
    if (row?.twilioSid && this.d.twilio) await this.d.twilio.hangUp(row.twilioSid);
  }

  async stopTap(tap: CardTapParams): Promise<CardTapResult> {
    const row = await this.d.store.byCard(tap.trip_id, tap.card_id);
    if (!row || (row.state !== 'dialing' && row.state !== 'talking')) return { result: 'refused', toast: 'The call has already ended.' };
    const pack = await this.d.packs.get(row.tripId);
    const name = pack.trip.people.find((p) => p.person_id === tap.person_id)?.name ?? 'someone';
    const live = this.live.get(row.callId);
    if (live) live.stoppedBy = name;
    // Answer the tap at once (3 s limit); hanging up and closing out run behind it.
    void (async () => {
      await this.hangUp(row.callId);
      if (!live) await this.finish(row.callId, 'stopped');
    })().catch((err: unknown) => this.d.log.warn({ err, callId: row.callId }, 'calls: stopping the call failed'));
    return { result: 'done', toast: 'Hanging up.' };
  }

  async onTwilioStatus(callId: string, status: string): Promise<void> {
    const o = twilioOutcome(status);
    if (o === 'busy' || o === 'no_answer' || o === 'failed' || o === 'canceled') return this.fail(callId, o);
    if (o !== 'completed') return;
    const row = await this.d.store.get(callId);
    if (row?.state === 'talking') return this.finish(callId, 'hangup');
    if (row?.state === 'dialing') return this.fail(callId, 'no_answer');
  }

  async fail(callId: string, why: FailWhy): Promise<void> {
    if (this.live.has(callId)) return this.finish(callId, why);
    const row = await this.d.store.end(callId, { state: 'failed', at: this.d.now(), outcome: FAIL_OUTCOME[why], reported: false, record: null, transcript: [], reason: why });
    if (row) await this.closeOut(row, null);
  }

  private async finish(callId: string, reason: string): Promise<void> {
    const live = this.live.get(callId) ?? null;
    const o = live?.outcome ?? null;
    const why = live?.stoppedBy ? 'stopped' : reason;
    const row = await this.d.store.end(callId, {
      state: 'ended',
      at: this.d.now(),
      outcome: o ? clip(plain(o.outcome), 500) : noOutcome(why, live?.stoppedBy ?? null),
      reported: o !== null,
      record: o?.record ?? null,
      transcript: live?.lines ?? [],
      reason: why,
    });
    this.live.delete(callId);
    if (!row) return;
    if (why === 'dropped') await this.hangUp(callId).catch((err: unknown) => this.d.log.warn({ err, callId }, 'calls: hanging up a dropped call failed'));
    await this.closeOut(row, live?.updater ?? null);
  }

  /** The final card, the line in the room, the record line. Safe to repeat: every write has a fixed request id. */
  private async closeOut(row: CallRow, updater: CardUpdater<CallCardIn> | null): Promise<void> {
    const final = this.card(row, {
      state: row.state === 'failed' ? 'failed' : 'ended',
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      lastLine: row.transcript.at(-1) ?? null,
      outcome: row.outcome,
      transcript: row.transcript,
    });
    if (row.cardMessageId) {
      if (updater) await updater.final(final);
      else await this.replace(row.tripId, final);
    }
    let recordLineId: string | null = null;
    if (row.state === 'failed') {
      await this.d.link.request('post_message', { request_id: rid(row.callId, 'fail'), trip_id: row.tripId, text: failLine(row.business, row.endReason ?? 'failed') });
    } else if (row.reported && row.outcome) {
      const pack = await this.d.packs.get(row.tripId);
      const organizer = pack.trip.people.find((p) => p.person_id === pack.trip.organizer_person_id && !p.go_paused) ?? null;
      const ask = row.record?.kind === 'open' ? organizer : null;
      const asked = row.askedMessageId ? pack.messages.find((m) => m.message_id === row.askedMessageId && !m.deleted) : undefined;
      await this.d.link.request('post_message', {
        request_id: rid(row.callId, 'outcome'),
        trip_id: row.tripId,
        text: clip(ask ? `${row.outcome} ${ask.name}, want to decide on this?` : row.outcome, 2000),
        ...(asked ? { reply_to: asked.message_id } : {}),
        ...(ask ? { mentions: [ask.person_id] } : {}),
      });
      if (row.record && row.cardMessageId) {
        const line = await this.d.link.request('add_record_line', {
          request_id: rid(row.callId, 'record'),
          trip_id: row.tripId,
          kind: row.record.kind,
          text: clip(plain(row.record.text), 200),
          proof: [{ message_id: row.cardMessageId }],
          person_ids: ask ? [ask.person_id] : [],
        });
        recordLineId = line.line_id;
      }
    } else {
      const text = row.endReason === 'stopped'
        ? `Okay, I hung up on ${row.business}.`
        : `I called ${row.business} but didn't get an answer to that. Want me to try again?`;
      await this.d.link.request('post_message', { request_id: rid(row.callId, 'outcome'), trip_id: row.tripId, text });
    }
    await this.d.store.closedOut(row.callId, this.d.now(), recordLineId);
  }

  private card(row: CallRow, o: { state: CardState; startedAt?: Date | null; endedAt?: Date | null; lastLine?: CallLine | null; outcome?: string | null; transcript?: CallLine[] }): CallCardIn {
    const isLive = o.state === 'dialing' || o.state === 'talking';
    const fallback = o.state === 'ended' && o.outcome
      ? `Go called ${row.business}: ${o.outcome}`
      : o.state === 'failed' ? `Go couldn't get through to ${row.business}.` : `Go is calling ${row.business}: ${row.goal}`;
    return {
      card_id: row.cardId,
      kind: 'call',
      fallback_text: clip(fallback, 300),
      call_id: row.callId,
      business: row.business,
      goal: row.goal,
      state: o.state,
      ...(o.startedAt ? { started_at: o.startedAt.toISOString() } : {}),
      ...(o.endedAt ? { ended_at: o.endedAt.toISOString() } : {}),
      ...(o.lastLine ? { last_line: o.lastLine } : {}),
      ...(o.outcome ? { outcome: clip(o.outcome, 500) } : {}),
      ...(o.transcript && o.transcript.length > 0 ? { transcript: o.transcript.slice(-300) } : {}),
      ...(isLive ? { actions: [{ action_id: 'stop', label: 'Stop the call', style: 'secondary' as const }] } : {}),
    };
  }

  private async replace(tripId: string, card: CallCardIn): Promise<void> {
    await this.d.link.request('replace_card', { trip_id: tripId, card });
  }
}
```

```ts
// apps/brain/src/calls/tool.ts
// call_business: the composer's quick tool for a phone call. It only posts Go's line and starts the 30 s
// window; the call service does the rest.
import { z } from 'zod';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
import type { CallService } from './service.js';

export const CallBusinessArgs = z.object({
  business: z.string().min(1).max(80),
  phone: z.string().min(5).max(32).optional(),
  goal: z.string().min(1).max(160),
  announce: z.string().min(1).max(300),
  facts_allowed: z.array(z.string().min(1).max(200)).max(10).default([]),
});
export type CallBusinessArgs = z.infer<typeof CallBusinessArgs>;

export function callTool(service: CallService): QuickTool<CallBusinessArgs> {
  return {
    name: 'call_business',
    description:
      'Phone a business for the group (a hotel about check-in, a cab about a pickup) and talk to them live. Only names under "Go can phone" work. Write announce as one short line saying who you will call and why; Go adds the 30 second stop notice and calls if nobody says stop. facts_allowed lists the only things the call may share. Never use it to pay. Afterwards, say nothing more about the call this turn.',
    input: CallBusinessArgs,
    async run(args: CallBusinessArgs, ctx: TurnCtx): Promise<unknown> {
      const r = await service.request(ctx.tripId, ctx.pack, {
        business: args.business,
        phone: args.phone,
        goal: args.goal,
        announce: args.announce,
        factsAllowed: args.facts_allowed,
      });
      if ('refused' in r) return r;
      ctx.outcome.spoke = true;
      return { ok: true, call_id: r.callId, note: 'Posted the call line. Say nothing more about the call now.' };
    },
  };
}
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/calls/card-updater.ts apps/brain/src/calls/service.ts apps/brain/src/calls/tool.ts apps/brain/src/calls/card-updater.test.ts apps/brain/src/calls/service.test.ts
git commit -m "feat(calls): call_business with a 30 second stop window, a live call card, and the outcome in the chat and the record

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `card-updater.test.ts` and `service.test.ts` pass; earlier tests stay green.
