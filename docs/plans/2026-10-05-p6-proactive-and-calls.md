# P6: Go speaks first, and calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Go speaks up on its own when it truly helps (timers, watches, openings in the chat), always through one bar, one budget and the quietest useful action, and Go phones a business for the group live, with a 30 second chance to stop it, a call card updated in place and the outcome in the chat and the record.

**Architecture:** Everything Go notices on its own (a timer coming due, a watch that saw a change, an opening in the chat or a trip change) becomes a row in `proactive_candidates` keyed by a stable dedupe key, so a nudge can never repeat. A promoter, every 15 seconds, runs due candidates through the pure policy (`proactive/policy.ts`: importance × confidence × urgency against bars that rise at night in the trip's time zone, after a hush and after ignored nudges; about 3 unprompted posts per trip per day; never two in a row without a person speaking; small things batched) and only a candidate that passes is put on the desk (kind `timer`, `watch` or `opening`) with the actions the bar allowed. The composer still picks the words; P1's turn enforces what is allowed through `Context.addTurnRules` (any other tool is refused, and the text is dropped when a message is not allowed), and the wake text, the `openings` "right now" block and P6's own notice tools say it and keep pins to the right people. Calls are their own service: `call_business` posts one line and waits 30 seconds in the `calls` table, then dials through Twilio's REST API with a `<Connect><Stream>` to Go's media socket (handed over by P1's `Door.onUpgrade`), which bridges Twilio's μ-law frames to the voice model over a plain WebSocket (`audio/pcmu` both ways, no separate transcriber), keeps the call card live with Go's side of the call (at most one update every 3 seconds), and closes out with the outcome message and, when it settles something, an `add_record_line` whose proof is the call card's message.

**Tech Stack:** Node 22, TypeScript strict (`exactOptionalPropertyTypes`), zod 4.3.6, Fastify 5, `ws` 8 (Go's media socket and the client socket to the voice model; no `openai` SDK because the repo pins `openai` 6.39.1 for the copied agent loop), `pg` 8, `@go/contract` 1.0.0, vitest 4 with the CI Postgres service, Twilio Programmable Voice REST + Media Streams over `fetch` (no `twilio` SDK), the voice model picked by `CALLS_VOICE_MODEL`: `gpt-realtime-2.1` over `wss://api.openai.com/v1/realtime` by default, or `gpt-live-1` behind the same bridge for the day-one A/B, never with a separate speech-to-text model.

**Spec:** `docs/spec/2026-10-05-go-design.md` §5 (timers), §8 (being proactive), §12 (status for watches), §14 (calls), §2 (watches, calls) and `docs/plans/2026-10-05-go-the-week.md` (master plan; sections 6 and 7 are binding). Cards: `docs/guide/06-cards.md` (call, notice); the call flow: `docs/guide/09-flows.md` §5.

**Lane / gate:** Lanes A (proactive, Tasks 1 to 8) then C (watches already in Tasks 7 and 8; calls, Tasks 9 to 14). Gate **G5 "Go speaks first, and calls", Thu 23:00**: timers, watches, the proactive bar and budget pass in CI; one real call to a teammate's phone with the live card and the outcome. Demo beats served (master §1): **1:00 "the call"** and **3:40 "proactive and safe"** (the labelled simulated watch, fired with `force: true`: the flight is 2 hours late and Arjun's cab is at 9; Go suggests moving it, pinned to Arjun).

**Depends on:**
- P1: `Brain` (with `onStop(fn)`, where each lane stops its timers), `RegisterLane` (`apps/brain/src/app.ts`); `Desk.put`, `DeskItem`, `DeskKind` (`desk/desk.ts`); `Context.addNow`, `Context.addWake`, `Context.addTurnRules(fn: (wake) => TurnLimits | null)` with `TurnLimits { tools; mayPostText }`, `NowProvider` (`composer/context.ts`); `Tools.register`, `QuickTool`, `TurnCtx` (with `allowedTools` and `mayPostText`, set from `addTurnRules`), `TurnOutcome` (`composer/tools.ts`); `MessageHooks.onRead` (`trips/hooks.ts`); `TripLog.onEvent` (`trips/log.ts`); `Packs.get`, `TripPack` (`trips/pack.ts`); `TapRouter.on('call', 'stop', ...)` (`door/taps.ts`); `Door.onUpgrade(path: RegExp, handle: UpgradeHandler)` (Twilio's media socket; `door/handlers.ts`) and `ServerLink.request` (`door/server-link.ts`); `TurnCtx.cards`, `TurnCtx.stableId(prefix)` (crash-safe ids for a quick tool's writes and cards); `Message`, `Trip`, `TripEvent`, `CardTapParams`, `CardTapResult` (`door/methods.ts`); `Switches.get('CALLS_MODE')` (`admin/switches.ts`); `withSchema()` (`db/test-db.ts`); the `trips` table (`trip_id`, `last_seq`, `tz` defaulting to `Asia/Kolkata`, `created_at`); `LANES` in `main.ts`; `Env` with `GO_PUBLIC_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `OPENAI_API_KEY`, `CALLS_MODE`, `CALLS_ALLOWLIST`, `ADMIN_TOKEN` (all optional strings); P1's `calls/env.ts` stub, where Task 9 adds `CALLS_VOICE_MODEL`. The hooks are settled in master §6.3; `startProactive` and `startCalls` fail at boot with one clear error line if `addTurnRules` or `onUpgrade` is missing.
- P2: `ReflexRead` with `opening: Sure<boolean>` and `forGo: Sure<boolean>` (`reflex/reflex.ts`; P1's stub until P2 lands); the quick tools named `react`, `record`, `trip`, `person`, `recall`; P1's `stay_silent`.
- P4: `Travel.status(q: StatusQuery): Promise<StatusResult>` (`travel/travel.ts`), used as it is: `StatusQuery` is `{ kind: 'flight'; carrierCode; number; date }` or `{ kind: 'pnr'; pnr }`, and `StatusResult` is `{ kind: 'flight'; state; scheduledDepartAt; expectedDepartAt; delayMinutes; checkedAt }` or `{ kind: 'pnr'; state; detail; checkedAt }` (interface note 3, settled).
- `@go/contract`: `TripSnapshot`, `Message`, `Event`, `NoticeCard`, `CallCard`.

## Global Constraints

Master §7 applies to every task. Specific to this plan:
- Calls go only to numbers in `CALLS_ALLOWLIST` (comma separated, each `+E164` or `Name=+E164`), and only while the `CALLS_MODE` switch reads `allowlist`; it is read again just before dialing.
- The stop window is exactly 30 s (`CALL_WINDOW_MS = 30_000`); a call is hung up at 4 minutes (`CALL_CAP_MS = 240_000`); Twilio's own `TimeLimit` is 255 s as a backstop.
- The call card is updated at most once every 3 s (`CARD_GAP_MS = 3_000`); the final card always lands.
- **No second ear (Keshav's ruling, `feedback-no-second-ear-on-the-call`):** Go hears the business with the voice model's own ears only. The bridge never turns on the realtime session's input transcription (`audio.input.transcription`, `gpt-4o-mini-transcribe` or any other) and never calls a separate speech-to-text service. The call card's `last_line` and `transcript` carry Go's own lines (`who: 'go'`, from the model's own output transcript) and the `outcome` from the model's report; the room hears the business on the speaker. Showing the business's words on the card needs Keshav's explicit OK.
- `CALLS_VOICE_MODEL` picks the voice model: `gpt-realtime-2.1` (the default, no input transcription) or `gpt-live-1` for the day-one A/B (its input transcript is the model's own, which the ruling allows, but Go still shows only its own lines). `gpt-live-1` has no "caller started speaking" event, so barge-in there uses Twilio `mark` events and an energy check on the business's audio.
- The call never pays: the session instructions forbid paying and sharing card, bank or UPI details, and `call_business` refuses a goal or fact that carries card, bank, OTP or password words or a long run of digits.
- On the call Go says it is an AI assistant in its first line and never names the model or its vendor; every string Go posts passes `plain()` (no em dashes, vendor names replaced with "Go").
- Night is 22:00 to 08:00 in the trip's time zone (`trips.tz`, default `Asia/Kolkata`).
- At most 3 unprompted posts (a pinned notice or a message to everyone) per trip per local day (`DAILY_POSTS = 3`).
- Every card from a simulated watch carries `source: { name: "Simulated for the demo" }`.
- A quick tool's writes and cards take their ids from `ctx.stableId(...)` (`c_notice`, `call`); every call write outside a turn uses `go_<call_id>_<step>` (`announce`, `card`, `cancel`, `off`, `outcome`, `record`, `fail`), so a crash and re-run never doubles a post. Proactive desk items are `<source>:<trip>:<dedupe key>`.
- Audio is never recorded or stored; only Go's own lines (at most 300) are kept, on the call card and in `calls.transcript`.
- `ADMIN_TOKEN` guards `POST /admin/watch/fire`; without it the route answers 404.
- `force: true` on `POST /admin/watch/fire` (the stage, master §1 3:40 and §9) skips the bar, night, the daily budget, "two in a row", the hush raise and the ignored-nudge raise for that one candidate only. It never skips the "Simulated for the demo" label, the pins to the named people, a person who paused Go, expiry, or the double-click guard (the same body in the same or previous minute posts once).

## Review Focus

1. **Go speaks up at the wrong moment**: at 23:30 in Goa, a fourth time in a day, twice in a row with nobody speaking in between, after a "Go chup kar", or pinging someone who paused Go. (Task 1 policy tests; Task 4 promoter tests for night and budget through the database; Task 6 hush test.)
2. **A nudge repeats**: the same timer re-planned on every event, the same flight delay read twice by a watch, a vote reminder after the vote already closed. (Task 2 "never re-added"; Task 3 replan tests; Task 4 stale-candidate drop; Task 8 runner dedupe.)
3. **Go calls when it must not** (includes master §10.3, someone steering Go): a number off the allowlist, `CALLS_MODE` flipped to `off` inside the window, "ruk jao", "band karo", "stop" or a "nahi" reply inside the window, a second call while one is live, "call the villa and give them Rahul's card 4111 1111 1111 1111". (Task 9 stop words; Task 12 service tests.)
4. **The call card lies or says too much**: stuck on talking after the business hangs up, a crash mid-call, the 4 minute cap, a Stop tap after the end (must answer "The call has already ended."), a media connection with a wrong token (must end nothing), or the business's words on the card (it carries Go's lines only, and no transcriber is ever turned on). (Task 11 bridge tests for both voice models; Task 12 sweep, tap and "Go's lines only" tests; Task 13 end to end; Task 14's day-one check fails if input transcription is on.)
5. **The demo's simulated watch looks real, never lands, or lands twice**: the notice must say "Simulated for the demo", be pinned to Arjun only, and arrive within a second of the admin tap, even when the real trip's daily budget is spent and a hush is on (the stage sends `force: true`); a double click posts once; the route must refuse without the admin token. (Task 1 forced-decision tests; Task 5 notice tool tests; Task 8 admin, demo-beat and forced stage-fire tests; Task 14 through the simulator.)

## File Structure

- `apps/brain/src/proactive/clock.ts`: the trip's local hour and day, "8 am tomorrow" as an instant, `Schedule` and `realSchedule`.
- `apps/brain/src/proactive/policy.ts`: the bar, the budget, the quietest useful action, batching; pure.
- `apps/brain/src/proactive/policy.test.ts`: policy and clock tests.
- `apps/brain/src/db/migrations/5000_proactive.sql`: `proactive_candidates`, `proactive_trips`, `proactive_notices`.
- `apps/brain/src/proactive/store.ts`: candidates, the trip's signals (posts today, hushes, ignored nudges), saved notices.
- `apps/brain/src/proactive/fakes.ts`: test fakes (the Goa trip, packs, a recording server link, a desk, a hand-moved clock, a fake `Brain` that records turn rules and lane upgrades and routes upgrades like P1's door).
- `apps/brain/src/proactive/store.test.ts`: store tests.
- `apps/brain/src/proactive/timers.ts`: timer planning, re-planning, date clashes, the "still true" check.
- `apps/brain/src/proactive/timers.test.ts`: timer tests.
- `apps/brain/src/proactive/payload.ts`: what a proactive desk item carries.
- `apps/brain/src/proactive/promoter.ts`: due candidates through the policy onto the desk.
- `apps/brain/src/proactive/promoter.test.ts`: promoter tests.
- `apps/brain/src/proactive/words.ts`: `plain()`, `clip()`, `quote()`, `rupees()`, `namesOf()`.
- `apps/brain/src/proactive/allowed.ts`: the tools a proactive turn may use, and `composerRules` for P1's `Context.addTurnRules`.
- `apps/brain/src/proactive/wake.ts`: wake renderers for `timer`, `watch`, `opening`; the `openings` "right now" block.
- `apps/brain/src/proactive/notice-tools.ts`: quick tools `post_notice` and `update_notice`.
- `apps/brain/src/proactive/wake.test.ts`, `apps/brain/src/proactive/notice-tools.test.ts`: tests.
- `apps/brain/src/proactive/openings.ts`: openings from the chat and from trip changes, hush, ignored nudges.
- `apps/brain/src/proactive/openings.test.ts`: tests.
- `apps/brain/src/db/migrations/5100_watches.sql`: `watches`.
- `apps/brain/src/watches/diff.ts`: which change between two of P4's `StatusResult` readings is worth a nudge.
- `apps/brain/src/watches/plan.ts`: which watches a trip needs (booked flights by number, booked trains by PNR, each stored as P4's `StatusQuery`); syncing them.
- `apps/brain/src/watches/watches.test.ts`: diff and plan tests.
- `apps/brain/src/watches/runner.ts`: scheduled checks through `Travel.status`.
- `apps/brain/src/watches/admin.ts`: `POST /admin/watch/fire`.
- `apps/brain/src/proactive/register.ts`: `startProactive(brain)` and `registerProactive(brain)`; also wires watches and the turn rules.
- `apps/brain/src/watches/runner.test.ts`, `apps/brain/src/proactive/register.test.ts`: tests, including the 3:40 demo beat.
- `apps/brain/src/db/migrations/5200_calls.sql`: `calls`.
- `apps/brain/src/calls/env.ts` (modify P1's stub): `CALLS_VOICE_MODEL`, and the allowlist's `Name=+E164` form in its comment.
- `apps/brain/src/calls/config.ts`: settings, allowlist, phone numbers, URLs, the voice model, fixed numbers.
- `apps/brain/src/calls/stop-words.ts`: "stop" in English and Hinglish.
- `apps/brain/src/calls/store.ts`: the call row and its state changes.
- `apps/brain/src/calls/foundation.test.ts`: config, stop words and store tests.
- `apps/brain/src/calls/twilio.ts`: Twilio REST client, TwiML, signature check, status words.
- `apps/brain/src/calls/twilio.test.ts`: tests.
- `apps/brain/src/calls/realtime.ts`: the call's instructions and greeting, `report_outcome`, opening the voice model's socket.
- `apps/brain/src/calls/voice-wire.ts`: the two voice models behind one shape (`gpt-realtime-2.1` and `gpt-live-1`), neither with input transcription.
- `apps/brain/src/calls/bridge.ts`: Twilio media socket to the voice model and back; Go's lines only; barge-in by the model's speech event, or by Twilio marks and an energy check.
- `apps/brain/src/calls/bridge.test.ts`: tests with a scripted local voice model, for both wires.
- `apps/brain/src/calls/card-updater.ts`: one card update every 3 s at most, the final one always.
- `apps/brain/src/calls/service.ts`: `CallService`: request, stop window, dial, live card, outcome, failures, sweep.
- `apps/brain/src/calls/tool.ts`: the `call_business` quick tool.
- `apps/brain/src/calls/card-updater.test.ts`, `apps/brain/src/calls/service.test.ts`: tests.
- `apps/brain/src/calls/register.ts`: `startCalls(brain)`, `registerCalls(brain)`: routes, the media socket through `Door.onUpgrade`, tap, hooks, the `calls` "right now" block.
- `apps/brain/src/calls/register.test.ts`: the whole call end to end.
- `apps/brain/src/main.ts` (modify): add `registerProactive` and `registerCalls` to `LANES`.
- `apps/brain/src/__tests__/e2e/proactive.e2e.test.ts`: G5, the 3:40 beat through the simulator and the real composer.
- `apps/brain/scripts/calls-day-one.mjs`: the day-one check for Twilio, India dialing, the media socket, and both voice models (mu-law, no input transcription).

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
  - `policy.ts`: `ACTIONS = ['react','record','update_card','pin','message'] as const`; `type Action`; `type Source = 'timer' | 'watch' | 'opening'`; `isPost(a: Action): boolean`; `interface Candidate { tripId; dedupeKey; source: Source; topic: string; dueAt: Date; expiresAt: Date | null; importance; confidence; urgency: number; useful: Action[]; personIds: string[]; facts: Record<string, unknown>; simulated: boolean; small: boolean; forced?: boolean }` (`forced` is set only by the stage's `POST /admin/watch/fire` with `force: true`, Task 8); `interface TripMood { tz; postsToday; lastProactivePostAt: Date | null; lastPersonMessageAt: Date | null; hushCount; lastHushAt: Date | null; ignoredCount; pausedPersonIds: string[] }`; `BARS`, `NIGHT_RAISE`, `HUSH_RAISE`, `HUSH_CAP`, `HUSH_LASTS_MS`, `IGNORED_RAISE`, `IGNORED_CAP`, `DAILY_POSTS`, `SMALL_HOLD_MS`, `RECHECK_MS`; `score(c): number`; `barRaise(m, now): { night: number; mood: number }`; `lastWordIsGos(m): boolean`; `type Decision`; `decide(c, m, now): Decision`; `decideBatch(cands, m, now): Array<{ candidate: Candidate; decision: Decision }>`.

The rules, in plain words. Each candidate says which actions would be useful (`useful`). The quiet actions (a reaction, a record line, updating a notice Go posted earlier) are allowed when the score clears their bar. Of the two posts, only the quietest one that applies is ever allowed: a pin when the nudge concerns particular people who have not paused Go, otherwise a message to everyone. Posts also need budget left today and a person to have spoken since Go's last unprompted post. Bars rise by 0.25 at night, by 0.15 per hush (for 72 hours, at most 0.45) and by 0.05 per ignored nudge (at most 0.2). Bars rise with loudness, so if the quietest useful action fails its bar, every louder one fails too.

The stage fire (master §1 3:40 and §9) is the one exception, and only for its own candidate: a candidate marked `forced` skips the score bar, the night raise, the daily budget, "two in a row", the hush raise and the ignored-nudge raise. Everything else still holds for it: an expired candidate is dropped, someone who paused Go is never pinged (all of them paused: dropped), and the post is still the quietest one that applies (a pin to the named people when there are any). It still counts as a post of the day, so real nudges after it wait their turn.

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

  it('lets the forced stage fire past the bar, night, the spent budget, two in a row, a hush and ignored nudges, for that candidate only', () => {
    const tired = mood({
      postsToday: DAILY_POSTS,
      lastProactivePostAt: new Date('2026-10-06T06:10:00Z'),
      lastPersonMessageAt: new Date('2026-10-06T06:00:00Z'),
      hushCount: 3,
      lastHushAt: NOON,
      ignoredCount: 4,
    });
    const stage = cand({ simulated: true, forced: true, importance: 0.1, dedupeKey: 'sim:flight_status:stage' });
    expect(decide(stage, tired, NOON)).toMatchObject({ kind: 'go', allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true });
    expect(decide(stage, tired, LATE)).toMatchObject({ kind: 'go', allowed: ['pin'], forPersonIds: ['p_arjun'] });
    // The same nudge without force is held back by the same mood.
    expect(decide({ ...stage, forced: false }, tired, NOON)).toEqual({ kind: 'drop', reason: 'below_bar' });
    expect(decide(cand({ useful: ['pin'] }), tired, NOON).kind).not.toBe('go');
  });

  it('still never pings a paused person, still drops what expired, and pins only the named people, even when forced', () => {
    const stage = cand({ simulated: true, forced: true });
    expect(decide(stage, mood({ pausedPersonIds: ['p_arjun'] }), NOON)).toEqual({ kind: 'drop', reason: 'paused' });
    expect(decide({ ...stage, expiresAt: NOON }, mood(), NOON)).toEqual({ kind: 'drop', reason: 'expired' });
    const two = decide({ ...stage, personIds: ['p_arjun', 'p_meher'] }, mood({ pausedPersonIds: ['p_meher'] }), NOON);
    expect(two).toMatchObject({ kind: 'go', allowed: ['pin'], forPersonIds: ['p_arjun'] });
    expect(decide({ ...stage, personIds: [], useful: ['pin'] }, mood(), NOON)).toEqual({ kind: 'drop', reason: 'nothing_useful' });
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
  /** The stage's fire with force: true (Task 8). Skips the bar, night, the budget, "two in a row", hush and ignored raises. */
  forced?: boolean;
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

/**
 * The stage fire (force: true): no score bar, no night, no budget, no "two in a row", no hush or ignored raise, for this
 * candidate only. The caller has already dropped it if it expired or everyone it names paused Go. The post is still the
 * quietest that applies, pinned to the people it names who have not paused Go.
 */
function decideForced(c: Candidate, targets: string[], s: number): Decision {
  const quiet = ACTIONS.filter((a) => !isPost(a) && c.useful.includes(a));
  const post: Action | null = c.useful.includes('pin') && targets.length > 0 ? 'pin' : c.useful.includes('message') ? 'message' : null;
  if (post === null && quiet.length === 0) return { kind: 'drop', reason: 'nothing_useful' };
  return { kind: 'go', allowed: post !== null ? [...quiet, post] : quiet, forPersonIds: post === 'pin' ? targets : [], counted: post !== null, score: s, bar: 0 };
}

export function decide(c: Candidate, m: TripMood, now: Date): Decision {
  if (c.expiresAt !== null && now.getTime() >= c.expiresAt.getTime()) return { kind: 'drop', reason: 'expired' };
  const paused = new Set(m.pausedPersonIds);
  const targets = c.personIds.filter((p) => !paused.has(p));
  if (c.personIds.length > 0 && targets.length === 0) return { kind: 'drop', reason: 'paused' };

  const s = score(c);
  if (c.forced === true) return decideForced(c, targets, s);
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
- Consumes: `Candidate`, `Action`, `Source`, `ACTIONS` (Task 1); `DEFAULT_TZ`, `isValidTz` (Task 1); `withSchema()` (P1); `Brain` (P1 `app.ts`); `DeskItem` (P1); `QuickTool`, `TurnCtx` (P1); `NowProvider`, `TurnLimits` (P1 `composer/context.ts`); `UpgradeHandler` (P1 `door/handlers.ts`); `ServerLink` (P1); `TripPack` (P1); `Message`, `Trip`, `TripEvent`, `CardTapParams`, `CardTapResult` (P1 `door/methods.ts`); `ReflexRead` (P1 stub / P2); `TripSnapshot`, `Message`, `Card`, `NoticeCard` from `@go/contract`.
- Produces:
  - `store.ts`: `type NoticeIn = z.input<typeof NoticeCard>`; `interface Signals { postsToday; lastProactivePostAt: Date | null; hushCount; lastHushAt: Date | null; ignoredCount }`; `interface SavedNotice { tripId; cardId; messageId: string | null; card: NoticeIn }`; `interface ToCheck { tripId; dedupeKey; decidedAt: Date }`; `class ProactiveStore` with `add(c): Promise<'added' | 'exists'>`, `plan(c): Promise<void>`, `dropUnplanned(tripId, keep: string[], now): Promise<number>`, `due(now, limit?): Promise<Candidate[]>`, `promote(c, d: { allowed: Action[]; forPersonIds: string[]; counted: boolean; localDay: string }, now): Promise<void>`, `defer(c, until, reason): Promise<void>`, `drop(c, reason, now): Promise<void>`, `status(tripId, key): Promise<{ status: string; reason: string | null; allowed: Action[] | null; counted: boolean; dueAt: Date } | null>`, `signals(tripId, localDay): Promise<Signals>`, `tripTz(tripId): Promise<string>`, `tripExists(tripId): Promise<boolean>`, `hush(tripId, now)`, `ignored(tripId, now)`, `resetBudget(tripId, localDay): Promise<number>`, `toCheckForIgnored(before, limit?): Promise<ToCheck[]>`, `ignoreChecked(tripId, key, now)`, `saveNotice(n: SavedNotice)`, `notice(tripId, cardId): Promise<SavedNotice | null>`.
  - `fakes.ts` (tests only): `GOA_TZ`, `goaTrip(over?)`, `msg(o)`, `goaPack(o?)`, `fakePacks(...packs)`, `fakeLink(o?)`, `fakeDesk()`, `manualTime(startIso)`, `waitFor(check, ms?)`, `candidate(over?)`, `unsureRead(over?)`, `turnCtx(o)`, `seedTrip(pool, tripId, tz?)`, `fakeBrain(o)` returning `{ brain, app, reg, link, desk, packs, switches }`. `fakeBrain` has P1's master §6.3 hooks: `context.addTurnRules` records into `reg.turnRules`, and `door.onUpgrade` records into `reg.upgrades`; `onStop` records into `reg.stops`; its Fastify server hands an upgrade on a registered path to that lane and refuses any other, as P1's door does.

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
    expect(got).not.toHaveProperty('forced');
  });

  it('keeps the stage fire marked forced', async () => {
    await store.add(candidate({ dedupeKey: 'sim:forced:1', simulated: true, forced: true, dueAt: new Date(NOON.getTime() - 1000) }));
    expect((await store.due(NOON)).find((c) => c.dedupeKey === 'sim:forced:1')).toMatchObject({ simulated: true, forced: true });
    await store.drop(candidate({ dedupeKey: 'sim:forced:1' }), 'test_done', NOON);
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

  it('lists the unprompted posts that still need the ignored check', async () => {
    const c = candidate({ dedupeKey: 'ign:1' });
    await store.add(c);
    await store.promote(c, { allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true, localDay: '2026-10-06' }, NOON);
    const rows = await store.toCheckForIgnored(new Date(NOON.getTime() + 1000));
    expect(rows).toContainEqual({ tripId: 't_goa', dedupeKey: 'ign:1', decidedAt: NOON });
    await store.ignoreChecked('t_goa', 'ign:1', NOON);
    expect((await store.toCheckForIgnored(new Date(NOON.getTime() + 1000))).map((r) => r.dedupeKey)).not.toContain('ign:1');
  });

  it('saves and reads back a notice card', async () => {
    const card = { card_id: 'c_notice_1', kind: 'notice' as const, fallback_text: 'Heads up', tone: 'heads_up' as const, title: 'Heads up', body: 'Your flight is late.' };
    await store.saveNotice({ tripId: 't_goa', cardId: 'c_notice_1', messageId: null, card });
    expect(await store.notice('t_goa', 'c_notice_1')).toEqual({ tripId: 't_goa', cardId: 'c_notice_1', messageId: null, card });
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
  -- Only the stage's fire with force: true sets it (Task 8).
  forced boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'promoted', 'dropped')),
  reason text,
  allowed text[],
  for_person_ids text[],
  counted boolean not null default false,
  decided_at timestamptz,
  local_day text,
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
  -- Null while the card rides with the turn's message (P1 posts it); kept for the record only.
  message_id text,
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
export interface SavedNotice { tripId: string; cardId: string; messageId: string | null; card: NoticeIn }
export interface ToCheck { tripId: string; dedupeKey: string; decidedAt: Date }

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
  forced: boolean;
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
    ...(r.forced ? { forced: true } : {}),
  };
}

const COLS = 'trip_id, dedupe_key, source, topic, due_at, expires_at, importance, confidence, urgency, useful, person_ids, facts, simulated, small, forced';
const PLACES = '$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15';
const values = (c: Candidate): unknown[] => [
  c.tripId, c.dedupeKey, c.source, c.topic, c.dueAt, c.expiresAt, c.importance, c.confidence, c.urgency,
  c.useful, c.personIds, JSON.stringify(c.facts), c.simulated, c.small, c.forced === true,
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

  async status(tripId: string, key: string): Promise<{ status: string; reason: string | null; allowed: Action[] | null; counted: boolean; dueAt: Date } | null> {
    const r = await this.pool.query<{ status: string; reason: string | null; allowed: string[] | null; counted: boolean; due_at: Date }>(
      `select status, reason, allowed, counted, due_at from proactive_candidates where trip_id = $1 and dedupe_key = $2`,
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

  async toCheckForIgnored(before: Date, limit = 100): Promise<ToCheck[]> {
    const r = await this.pool.query<{ trip_id: string; dedupe_key: string; decided_at: Date }>(
      `select trip_id, dedupe_key, decided_at from proactive_candidates
       where status = 'promoted' and counted and ignore_checked_at is null and decided_at < $1
       order by decided_at limit $2`,
      [before, limit],
    );
    return r.rows.map((x) => ({ tripId: x.trip_id, dedupeKey: x.dedupe_key, decidedAt: x.decided_at }));
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
    const r = await this.pool.query<{ message_id: string | null; card: NoticeIn }>(
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
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Message as MessageSchema, TripSnapshot, type Card } from '@go/contract';
import Fastify from 'fastify';
import type pg from 'pg';
import type { Brain } from '../app.js';
import type { NowProvider, TurnLimits } from '../composer/context.js';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
import type { DeskItem } from '../desk/desk.js';
import type { UpgradeHandler } from '../door/handlers.js';
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
          { label: 'Villa Sol', price_minor: 5420000, currency: 'INR', option_ref: 'opt_villa_sol' },
          { label: 'Casa Azul', price_minor: 6180000, currency: 'INR', option_ref: 'opt_casa_azul' },
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

/** A turn context like P1's makeTurnCtx: stableId(prefix) gives `<prefix>_<turnId>_<n>`, the same on a rerun. */
export function turnCtx(o: { link: ServerLink; pack: TripPack; wake: DeskItem[]; turnId?: string }): TurnCtx {
  const turnId = o.turnId ?? 'turn_test';
  const counts = new Map<string, number>();
  return {
    tripId: o.pack.trip.trip_id,
    turnId,
    link: o.link,
    pack: o.pack,
    outcome: { spoke: false, silent: false, reactions: 0, posts: [] as string[] },
    wake: o.wake,
    cards: [] as Card[],
    stableId(prefix: string): string {
      const n = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, n);
      return `${prefix}_${turnId}_${n}`;
    },
    signal: new AbortController().signal,
  } as TurnCtx;
}

export async function seedTrip(pool: pg.Pool, tripId: string, tz = GOA_TZ): Promise<void> {
  await pool.query(`insert into trips (trip_id, last_seq, tz) values ($1, 0, $2) on conflict (trip_id) do nothing`, [tripId, tz]);
}

type ReadHook = (msg: Message, read: ReflexRead, pack: TripPack) => Promise<void>;
type EventHook = (ev: TripEvent) => void | Promise<void>;
type TapHook = (tap: CardTapParams, card: Card) => Promise<CardTapResult>;
type TurnRulesFn = (wake: DeskItem[]) => TurnLimits | null;

export interface Registered {
  tools: Array<QuickTool<any>>;
  wakes: Map<string, (item: DeskItem, pack: TripPack) => string>;
  nows: NowProvider[];
  onRead: ReadHook[];
  onEvent: EventHook[];
  taps: Map<string, TapHook>;
  turnRules: TurnRulesFn[];
  upgrades: Array<{ path: RegExp; handle: UpgradeHandler }>;
  stops: Array<() => Promise<void> | void>;
}

/** A Brain whose parts record what a lane registers. `http` is a real Fastify instance (not listening). */
export function fakeBrain(o: { pool: pg.Pool; now: () => Date; env?: Record<string, string>; switches?: Record<string, string>; pack?: TripPack }) {
  const app = Fastify();
  const reg: Registered = { tools: [], wakes: new Map(), nows: [], onRead: [], onEvent: [], taps: new Map(), turnRules: [], upgrades: [], stops: [] };
  // Like P1's door: an upgrade on a lane's path goes to that lane; any other path is refused.
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const lane = reg.upgrades.find((u) => u.path.test(path));
    if (lane) lane.handle(req, socket, head);
    else socket.destroy();
  });
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
    onStop: (fn: () => Promise<void> | void): void => { reg.stops.push(fn); },
    door: {
      link,
      handle: (): void => {},
      onUpgrade: (path: RegExp, handle: UpgradeHandler): void => { reg.upgrades.push({ path, handle }); },
    },
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
      addTurnRules: (fn: TurnRulesFn): void => { reg.turnRules.push(fn); },
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

Decision: timers are candidates in `proactive_candidates` with a future `due_at`, not desk items with a future due time. The desk has no gate before a turn, so a timer put straight on the desk would always cost a model turn and could not be held for the morning or for the budget. The promoter (Task 4) puts the desk item, with a stable lane-prefixed id (`timer:<trip>:<dedupe key>`), only when the bar passes. Each timer's dedupe key carries the moment it is about (`vote_closing:d_villa:<closes_at>`), so moving a vote's closing time plans a new reminder and drops the old one.

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
  - `payload.ts`: `PROACTIVE_KINDS = ['timer', 'watch', 'opening'] as const`; `ProactivePayload` (zod) and its type `{ candidate: { ...Candidate with ISO strings, forced: boolean }; allowed: Action[]; forPersonIds: string[]; tz: string }`; `toPayload(c: Candidate, d: Extract<Decision, { kind: 'go' }>, tz: string): ProactivePayload`; `fromPayload(p: ProactivePayload['candidate']): Candidate`; `proactiveOf(item: DeskItem): ProactivePayload | null`; `deskId(c: Pick<Candidate, 'source' | 'tripId' | 'dedupeKey'>): string` (`<source>:<trip>:<key>`, e.g. `watch:t_goa:flight:t_goa:b_flight:delay:120`).
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
    expect(item).toMatchObject({ id: 'watch:t_goa:delay:1', tripId: 't_goa', kind: 'watch', ref: 'watch:t_goa:delay:1' });
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
    expect(desk.items.filter((i) => i.id === 'watch:t_goa:join:1')).toHaveLength(1);
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
    forced: z.boolean().default(false),
  }),
  allowed: z.array(z.enum(ACTIONS)).min(1),
  forPersonIds: z.array(z.string()),
  tz: z.string(),
});
export type ProactivePayload = z.infer<typeof ProactivePayload>;

export function toPayload(c: Candidate, d: Extract<Decision, { kind: 'go' }>, tz: string): ProactivePayload {
  return {
    candidate: { ...c, forced: c.forced === true, dueAt: c.dueAt.toISOString(), expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null },
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

/** Lane-prefixed and stable: `timer:<trip>:<key>`, `watch:<trip>:<key>`, `opening:<trip>:<key>`. */
export const deskId = (c: Pick<Candidate, 'source' | 'tripId' | 'dedupeKey'>): string => `${c.source}:${c.tripId}:${c.dedupeKey}`;
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
- Consumes: `Action`, `Candidate` (Task 1); `localWhen` (Task 1); `ProactiveStore`, `NoticeIn` (Task 2); `ProactivePayload`, `proactiveOf`, `fromPayload`, `toPayload`, `deskId` (Task 4); `DeskItem` (P1); `NowProvider`, `TurnLimits` (P1); `QuickTool`, `TurnCtx` with `cards`, `stableId(prefix)` (P1); `TripPack` (P1); `NoticeCard` (`@go/contract`).
- Produces:
  - `words.ts`: `plain(text): string`; `clip(text, max): string`; `quote(text, max?): string`; `rupees(minor): string`; `namesOf(ids, people): string`.
  - `allowed.ts`: `TOOLS_FOR: Record<Action, readonly string[]>`; `ALWAYS: readonly string[]` (`stay_silent`, `trip`, `person`, `recall`); `interface TurnRules { allowed: Action[]; tools: string[]; mayPostText: boolean; pinOnlyFor: string[] | null; dedupeKeys: string[] }`; `rulesForTurn(wake: DeskItem[]): TurnRules | null` (null when anything other than Go's own noticing woke the turn); `composerRules(wake: DeskItem[]): TurnLimits | null` (P1's `TurnLimits { tools: string[]; mayPostText: boolean }`, exactly what `Context.addTurnRules` takes, master §6.3; P1's loop always lets `stay_silent` through); `simulatedIn(wake: DeskItem[]): boolean`.
  - `wake.ts`: `describeNoticed(c, pack, tz, now): string`; `renderWake(item, pack, now): string`; `OPENINGS_ORDER = 60`; `openingsNow(): NowProvider` (name `openings`).
  - `notice-tools.ts`: `SIMULATED_SOURCE = 'Simulated for the demo'`; `interface NoticeToolDeps { store: ProactiveStore; now: () => Date; onPosted?: (p: ProactivePayload, cardId: string) => Promise<void> }`; `noticeTools(deps): [QuickTool<PostNoticeArgs>, QuickTool<UpdateNoticeArgs>]` (tools `post_notice`, `update_notice`).

How the limits are enforced (master §6.3, settled): P1's turn asks every `Context.addTurnRules` function for the turn's rules, and Task 8 registers `composerRules` from this task. For a turn woken only by things Go noticed itself, it answers the tools the bar allowed (plus reading and `stay_silent`) and whether a text message may be posted; P1's loop then refuses a call to any other tool with an error result (the tool definitions never change, so the 1 h cache holds) and drops the turn's final text when `mayPostText` is false. For any turn a person, a tap or a task woke, it answers null and the normal rules apply. On top of that: (1) the wake text names exactly what is allowed and (2) the `openings` block lists the tools this turn may use and whether a text message is allowed, so the model does not spend a round on a refused call; (3) `post_notice` (which adds its card to `ctx.cards`, so it rides after the turn's text with P1's stable request ids; its card id is `ctx.stableId('c_notice')`) and `update_notice` refuse anything the bar did not allow, keep pins to the people the bar named, strip anyone who paused Go, and force the "Simulated for the demo" source whenever a simulated item is in the turn, even when a person's message woke the same turn.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/brain/src/proactive/wake.test.ts
import { describe, expect, it } from 'vitest';
import type { DeskItem } from '../desk/desk.js';
import { ALWAYS, composerRules, rulesForTurn, simulatedIn } from './allowed.js';
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
  facts: { label: 'IndiGo 6E 2134', state: 'delayed', delayMinutes: 120, arriveAt: '2026-11-06T22:45:00+05:30', note: "Arjun's airport cab is booked for 9 pm", simulated: true },
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

  it('hands P1 exactly the tools and the text rule, and nothing for a turn a person woke', () => {
    expect(composerRules([messageItem, proItem(delay, ['pin'], ['p_arjun'])])).toBeNull();
    const r = composerRules([proItem(delay, ['pin'], ['p_arjun'])]);
    expect(Object.keys(r ?? {}).sort()).toEqual(['mayPostText', 'tools']);
    expect(r?.mayPostText).toBe(false);
    expect(r?.tools).toEqual(expect.arrayContaining(['post_notice', 'stay_silent', 'trip', 'person', 'recall']));
    expect(r?.tools).not.toContain('call_business');
    expect(r?.tools).not.toContain('start_task');
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

  it('reads a watched flight and a train ticket from P4 status words, with how old the check is', () => {
    const late = candidate({
      topic: 'flight_status', personIds: ['p_rahul'],
      facts: { label: 'IndiGo 6E 2134', state: 'delayed', delayMinutes: 45, expectedDepartAt: '2026-11-06T13:30:00Z', checkedAt: '2026-10-06T06:27:00Z' },
    });
    const flightText = describeNoticed(late, goaPack(), 'Asia/Kolkata', NOW);
    expect(flightText).toContain('"IndiGo 6E 2134" is running 45 minutes late, now leaving');
    expect(flightText).toContain('(checked 3 min ago)');
    expect(flightText).toContain('It concerns Rahul.');
    const ticket = candidate({ topic: 'pnr_status', personIds: ['p_meher', 'p_arjun'], facts: { label: 'Mandovi Express', state: 'confirmed', detail: 'CNF B2 34', checkedAt: NOW.toISOString() } });
    expect(describeNoticed(ticket, goaPack(), 'Asia/Kolkata', NOW)).toBe('The train ticket "Mandovi Express" is now confirmed ("CNF B2 34") (checked just now). It concerns Meher and Arjun.');
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
    expect(out).toMatchObject({ posted: true, card_id: 'c_notice_turn_test_1', pinned_for: ['p_arjun'] });
    expect(link.calls).toHaveLength(0); // P1 posts ctx.cards with the turn's message
    const card = ctx.cards[0] as Record<string, unknown>;
    expect(card).toMatchObject({ card_id: 'c_notice_turn_test_1', kind: 'notice', tone: 'heads_up', for_person_ids: ['p_arjun'], source: { name: SIMULATED_SOURCE } });
    expect(String(card.title)).not.toContain('—');
    expect(await store.notice('t_goa', 'c_notice_turn_test_1')).not.toBeNull();
    expect(posted.at(-1)?.cardId).toBe('c_notice_turn_test_1');
  });

  it('pins to the people the bar named when the model forgets to', async () => {
    const c = candidate({ dedupeKey: 'free:1', source: 'timer', topic: 'free_cancel', personIds: ['p_rahul'] });
    const [post] = tools();
    const ctx = turnCtx({ link: fakeLink(), pack: goaPack(), wake: [proItem(c, ['pin'], ['p_rahul'])], turnId: 'turn_free' });
    await post.run(post.input.parse({ tone: 'heads_up', title: 'Free cancellation ends tomorrow', body: 'Villa Sol is free to cancel until Sunday night.' }), ctx);
    expect((ctx.cards[0] as Record<string, unknown>).for_person_ids).toEqual(['p_rahul']);
  });

  it('refuses when the bar allowed only quiet actions', async () => {
    const c = candidate({ dedupeKey: 'quiet:1', source: 'opening', topic: 'chat', personIds: [] });
    const [post] = tools();
    const link = fakeLink();
    const ctx = turnCtx({ link, pack: goaPack(), wake: [proItem(c, ['react'])] });
    const out = await post.run(post.input.parse({ tone: 'info', title: 'Hi', body: 'Hello' }), ctx);
    expect(out).toHaveProperty('refused');
    expect(ctx.cards).toHaveLength(0);
  });

  it('never pins someone who paused Go', async () => {
    const base = goaTrip();
    const trip = goaTrip({ people: base.people.map((p) => (p.person_id === 'p_arjun' ? { ...p, go_paused: true } : p)) });
    const c = candidate({ dedupeKey: 'paused:1' });
    const [post] = tools();
    const link = fakeLink();
    const ctx = turnCtx({ link, pack: goaPack({ trip }), wake: [proItem(c, ['pin'], ['p_arjun'])] });
    const out = await post.run(post.input.parse({ tone: 'heads_up', title: 'Late', body: 'Late flight' }), ctx);
    expect(out).toHaveProperty('refused');
    expect(ctx.cards).toHaveLength(0);
  });

  it('labels a simulated item even in a turn a person woke, and strips paused people there too', async () => {
    const base = goaTrip();
    const trip = goaTrip({ people: base.people.map((p) => (p.person_id === 'p_meher' ? { ...p, go_paused: true } : p)) });
    const delay = candidate({ dedupeKey: 'sim:flight_status:2', simulated: true });
    const [post] = tools();
    const ctx = turnCtx({ link: fakeLink(), pack: goaPack({ trip }), wake: [messageItem, proItem(delay, ['pin'], ['p_arjun'])], turnId: 'turn_mixed' });
    await post.run(post.input.parse({ tone: 'heads_up', title: 'Late flight', body: 'Two hours late.', for_person_ids: ['p_arjun', 'p_meher'] }), ctx);
    const card = ctx.cards[0] as Record<string, unknown>;
    expect(card.source).toEqual({ name: SIMULATED_SOURCE });
    expect(card.for_person_ids).toEqual(['p_arjun']);
  });
});

describe('update_notice', () => {
  it('replaces a notice Go posted, in place', async () => {
    const delay = candidate({ dedupeKey: 'sim:flight_status:3', simulated: true });
    const [post, update] = tools();
    const link = fakeLink();
    const ctx = turnCtx({ link, pack: goaPack(), wake: [proItem(delay, ['pin'], ['p_arjun'])], turnId: 'turn_update' });
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
import type { TurnLimits } from '../composer/context.js';
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

/** What P1's turn takes through Context.addTurnRules (master §6.3, P1's TurnLimits): the tools this turn may call and whether its text is posted. */
export function composerRules(wake: DeskItem[]): TurnLimits | null {
  const r = rulesForTurn(wake);
  return r ? { tools: r.tools, mayPostText: r.mayPostText } : null;
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
      // Facts use P4's status words (state, delayMinutes, expectedDepartAt); the demo's fire adds arriveAt and a note.
      const delay = num('delayMinutes');
      const cancelled = str('state') === 'cancelled';
      const state = cancelled
        ? 'is cancelled'
        : delay !== null && delay > 0 ? `is running ${delay} minutes late` : 'is back on time';
      const leaves = cancelled ? null : at('expectedDepartAt');
      const lands = cancelled ? null : at('arriveAt');
      const when = `${leaves ? `, now leaving ${localWhen(leaves, tz)}` : ''}${lands ? `, now landing ${localWhen(lands, tz)}` : ''}`;
      const checked = str('checkedAt') ? ` (checked ${ago(str('checkedAt'), now)})` : '';
      const note = str('note') ? ` Also: ${quote(str('note'), 200)}` : '';
      const concerns = c.personIds.length > 0 ? ` It concerns ${who(c.personIds)}.` : '';
      return `${quote(str('label') || 'A flight')} ${state}${when}${checked}.${note}${concerns}`;
    }
    case 'pnr_status': {
      const what = str('label') ? ` ${quote(str('label'))}` : '';
      const state = str('state') === 'cancelled' ? 'is cancelled' : str('state') === 'confirmed' ? 'is now confirmed' : `is ${str('state') || 'changed'}`;
      const detail = str('detail') ? ` (${quote(str('detail'), 80)})` : '';
      const checked = str('checkedAt') ? ` (checked ${ago(str('checkedAt'), now)})` : '';
      const concerns = c.personIds.length > 0 ? ` It concerns ${who(c.personIds)}.` : '';
      return `The train ticket${what} ${state}${detail}${checked}.${concerns}`;
    }
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
import { z } from 'zod';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
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
  /** Called once per proactive item in the turn when a notice is queued (watches remember the card). */
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
        card_id: ctx.stableId('c_notice'),
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
      // The card rides with the turn's message (P1 posts ctx.cards after the text, with stable request ids).
      ctx.cards.push(card);
      await deps.store.saveNotice({ tripId: ctx.tripId, cardId: card.card_id, messageId: null, card });
      for (const item of ctx.wake) {
        const p = proactiveOf(item);
        if (p) await deps.onPosted?.(p, card.card_id);
      }
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
- Produces: `HUSH_RE`; `CHAT_WAIT_MS = 15_000`; `CHAT_EXPIRES_MS`; `IGNORED_AFTER_MS = 6 h`; `REPLAN_ON: ReadonlySet<string>`; `talksToGo(msg, pack): boolean`; `isHush(msg, pack): boolean`; `chatOpening(msg, read, now, tripId): Candidate | null`; `tripChangeOpenings(ev: TripEvent, trip: Trip, now: Date): Candidate[]`; `wasEngaged(pack, decidedAt, windowMs): boolean`; `interface OpeningsDeps { store; packs: Pick<Packs, 'get'>; readTrip(tripId): Promise<Trip>; replan(tripId: string, trip: Trip): Promise<void>; now: () => Date }`; `createOpenings(deps): { onRead(msg, read, pack): Promise<void>; onEvent(ev): Promise<void>; checkIgnored(): Promise<number> }`.

Sources (spec §8):
- **The chat.** When the reflex is sure there is an opening (`read.opening` sure true) and the message is not already for Go, a `chat` candidate is due in 15 s (so a friend who answers first is seen by the turn) and expires after 10 minutes. Useful: a reaction, a record line, or one message; the policy narrows that.
- **Trip changes.** A vote a person closed (not Go, `reason !== 'closed_by_go'`), a booking someone else cancelled, and new dates (or a new booking) that clash with a confirmed booking. `trip.updated` carries no values, so Go reads the trip with `read_trip` before checking dates. Every trip change also re-plans timers and watches through `deps.replan`.
- **Hush.** A message to Go (it mentions Go or replies to Go) that says hush, shush, be quiet, shut up, chup, chup kar, bas kar, stop pinging or too many messages raises the bar for that trip (Task 1).
- **Ignored.** Six hours after an unprompted post (Go's messages in the two minutes after the promotion), if no person reacted to them, replied to them or spoke to Go since, it counts as ignored and raises the bar a little.

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
    expect(wasEngaged(goaPack({ messages: [goMsg] }), at, six)).toBe(false);
    const reacted = msg({ id: 'm_go_1', by: 'go', sentAt: '2026-10-06T06:30:05Z', reactions: [{ emoji: '👍', person_id: 'p_arjun' }] });
    expect(wasEngaged(goaPack({ messages: [reacted] }), at, six)).toBe(true);
    const reply = msg({ by: 'p_arjun', replyTo: 'm_go_1', sentAt: '2026-10-06T07:00:00Z' });
    expect(wasEngaged(goaPack({ messages: [goMsg, reply] }), at, six)).toBe(true);
  });
  it('treats a nudge that posted nothing as nothing to ignore', () => {
    expect(wasEngaged(goaPack(), at, six)).toBe(true);
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

/**
 * Did anyone react to, reply to, or talk to Go after an unprompted post? The post is Go's messages in the
 * two minutes after the promotion. A nudge that posted nothing is never "ignored".
 */
export function wasEngaged(pack: TripPack, decidedAt: Date, windowMs: number): boolean {
  const from = decidedAt.getTime();
  const until = from + windowMs;
  const goIds = new Set<string>();
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
        if (!wasEngaged(pack, row.decidedAt, IGNORED_AFTER_MS)) {
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
- Create: `apps/brain/src/watches/diff.ts`
- Create: `apps/brain/src/watches/plan.ts`
- Test: `apps/brain/src/watches/watches.test.ts`

**Interfaces:**
- Consumes: `Action` (Task 1); `goaTrip` (Task 2); `StatusQuery`, `StatusResult` (P4 `travel/travel.ts`); `Trip` (P1); `withSchema()` (P1).
- Produces:
  - `diff.ts`: `type WatchKind = StatusQuery['kind']` (`'flight' | 'pnr'`); `interface WatchInfo { watchId; kind: WatchKind; label; hasNotice: boolean; hasPeople: boolean; endsAt: Date }`; `interface WatchChange { changeKey; importance; confidence; urgency; small; useful: Action[]; facts: Record<string, unknown> }`; `diffReading(w, before: StatusResult | null, after: StatusResult, now: Date): WatchChange | null`.
  - `plan.ts`: `interface WatchPlan { watchId; tripId; query: StatusQuery; personIds; label; startAt: Date; endsAt: Date }`; `planWatches(trip, now): WatchPlan[]`; `syncWatches(pool, trip, now): Promise<void>`; `noteWatchNotice(pool, watchId, cardId): Promise<void>`.

Watches read P4's `Travel.status` as it is, with no adapter: a watch stores the `StatusQuery` it sends and the last `StatusResult` it got, so a shape change in P4 is a compile error here, not a surprise at run time. The watches a trip gets (spec §8 "The world", §12 "Status"):
- **Flight status** for each confirmed flight booking with a carrier code and number (`{ kind: 'flight', carrierCode, number, date }`): checks start 24 h before departure and stop an hour after arrival. A change matters when the delay crosses into a new 15-minute step at 30 minutes or more, or the flight is cancelled; once Go posted a notice, a later change may update it in place, and "back on time" only ever updates it. Urgency counts to the scheduled departure, the time people planned around.
- **Train ticket status** for each confirmed train booking that has not left yet, by its PNR (`{ kind: 'pnr', pnr: booking.ref }`): checks from now until departure. A change matters when a waitlisted ticket is confirmed, or the ticket is cancelled. `not_found` says nothing (a fresh PNR may not be in the system yet).
- **Fares and rooms left are not watched this week**: P4's `StatusQuery` has no kind for them (interface note 3 says what P4 would add).

Each change has a change key (`<watch_id>:delay:120`, `<watch_id>:confirmed`), which is the candidate's dedupe key, so the same change is never nudged twice.

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/watches/watches.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import { goaTrip } from '../proactive/fakes.js';
import type { StatusResult } from '../travel/travel.js';
import { diffReading, type WatchInfo } from './diff.js';
import { noteWatchNotice, planWatches, syncWatches } from './plan.js';

const NOW = new Date('2026-11-06T07:00:00Z'); // travel day, under 6 hours before the 12:45Z departure
const SCHEDULED = '2026-11-06T18:15:00+05:30';
const flight = (delayMinutes: number, state: 'scheduled' | 'delayed' | 'cancelled' = delayMinutes > 0 ? 'delayed' : 'scheduled'): StatusResult => ({
  kind: 'flight',
  state,
  scheduledDepartAt: SCHEDULED,
  expectedDepartAt: new Date(Date.parse(SCHEDULED) + delayMinutes * 60_000).toISOString(),
  delayMinutes,
  checkedAt: NOW.toISOString(),
});
const pnr = (state: 'confirmed' | 'waitlisted' | 'cancelled' | 'not_found', detail = ''): StatusResult => ({ kind: 'pnr', state, detail, checkedAt: NOW.toISOString() });
const info = (over: Partial<WatchInfo> = {}): WatchInfo => ({
  watchId: 'flight:t_goa:b_flight', kind: 'flight', label: 'IndiGo 6E 2134', hasNotice: false, hasPeople: true, endsAt: new Date('2026-11-06T16:15:00Z'), ...over,
});

/** The Goa trip with a train booked for Meher and Arjun, so its PNR is watched too. */
function withTrain(status: 'confirmed' | 'cancelled' = 'confirmed') {
  const base = goaTrip();
  return goaTrip({
    bookings: [
      ...base.bookings,
      {
        booking_id: 'b_train', kind: 'train', status, title: 'Mandovi Express, Mumbai to Madgaon', vendor: 'ixigo', ref: '8524117390',
        amount_minor: 210000, currency: 'INR', payer_person_id: 'p_meher', for_person_ids: ['p_meher', 'p_arjun'],
        starts_at: '2026-11-05T07:10:00+05:30', ends_at: '2026-11-05T19:00:00+05:30', created_at: '2026-10-05T11:00:00Z',
      },
    ],
  });
}

describe('diffReading: flights', () => {
  it('says nothing about a flight on time', () => {
    expect(diffReading(info(), null, flight(0), NOW)).toBeNull();
    expect(diffReading(info(), flight(0), flight(10), NOW)).toBeNull();
  });

  it('flags a delay of 30 minutes or more, once per 15-minute step, in P4 status words', () => {
    const c = diffReading(info(), flight(0), flight(120), NOW);
    expect(c).toMatchObject({
      changeKey: 'flight:t_goa:b_flight:delay:120',
      importance: 0.9,
      urgency: 0.9,
      useful: ['pin', 'message'],
      facts: { state: 'delayed', delayMinutes: 120, scheduledDepartAt: SCHEDULED, expectedDepartAt: '2026-11-06T14:45:00.000Z', beforeDelayMinutes: 0 },
    });
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

describe('diffReading: train tickets by PNR', () => {
  const BEFORE_TRAIN = new Date('2026-11-04T10:00:00Z');
  const ticket = info({ watchId: 'pnr:t_goa:b_train', kind: 'pnr', label: 'Mandovi Express, Mumbai to Madgaon', endsAt: new Date('2026-11-05T01:40:00Z') });

  it('flags a waitlisted ticket that is confirmed, and a cancellation, once each', () => {
    expect(diffReading(ticket, null, pnr('confirmed', 'CNF B2 34'), BEFORE_TRAIN)).toBeNull();
    expect(diffReading(ticket, null, pnr('waitlisted', 'WL 12'), BEFORE_TRAIN)).toBeNull();
    expect(diffReading(ticket, pnr('waitlisted', 'WL 12'), pnr('waitlisted', 'WL 4'), BEFORE_TRAIN)).toBeNull();
    expect(diffReading(ticket, pnr('waitlisted', 'WL 4'), pnr('confirmed', 'CNF B2 34'), BEFORE_TRAIN)).toMatchObject({
      changeKey: 'pnr:t_goa:b_train:confirmed',
      importance: 0.6,
      urgency: 0.7,
      useful: ['pin', 'message'],
      facts: { state: 'confirmed', detail: 'CNF B2 34', beforeState: 'waitlisted' },
    });
    expect(diffReading(ticket, pnr('confirmed'), pnr('cancelled'), BEFORE_TRAIN)).toMatchObject({ changeKey: 'pnr:t_goa:b_train:cancelled', importance: 1 });
    expect(diffReading(ticket, pnr('cancelled'), pnr('cancelled'), BEFORE_TRAIN)).toBeNull();
    expect(diffReading(ticket, pnr('waitlisted'), pnr('not_found'), BEFORE_TRAIN)).toBeNull();
  });
});

describe('planWatches and syncWatches', () => {
  it('watches the booked flight by its number and the booked train by its PNR, as P4 status queries', () => {
    const plans = planWatches(withTrain(), new Date('2026-10-06T06:30:00Z'));
    expect(plans.map((p) => p.watchId)).toEqual(['flight:t_goa:b_flight', 'pnr:t_goa:b_train']);
    const [f, t] = plans;
    expect(f).toMatchObject({ personIds: ['p_rahul', 'p_priya', 'p_kabir'], label: 'IndiGo 6E 2134', query: { kind: 'flight', carrierCode: '6E', number: '2134', date: '2026-11-06' } });
    expect(f?.startAt.toISOString()).toBe('2026-11-05T12:45:00.000Z');
    expect(f?.endsAt.toISOString()).toBe('2026-11-06T16:15:00.000Z');
    expect(t).toMatchObject({ personIds: ['p_meher', 'p_arjun'], label: 'Mandovi Express, Mumbai to Madgaon', query: { kind: 'pnr', pnr: '8524117390' } });
    expect(t?.startAt.toISOString()).toBe('2026-10-06T06:30:00.000Z');
    expect(t?.endsAt.toISOString()).toBe('2026-11-05T01:40:00.000Z');
    // Once the train has left, only the flight is watched.
    expect(planWatches(withTrain(), new Date('2026-11-05T02:00:00Z')).map((p) => p.watchId)).toEqual(['flight:t_goa:b_flight']);
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
    await syncWatches(db.pool, withTrain(), now);
    await syncWatches(db.pool, withTrain(), now);
    const active = await db.pool.query<{ watch_id: string; kind: string; query: unknown }>(`select watch_id, kind, query from watches where active order by watch_id`);
    expect(active.rows).toEqual([
      { watch_id: 'flight:t_goa:b_flight', kind: 'flight', query: { kind: 'flight', carrierCode: '6E', number: '2134', date: '2026-11-06' } },
      { watch_id: 'pnr:t_goa:b_train', kind: 'pnr', query: { kind: 'pnr', pnr: '8524117390' } },
    ]);

    await syncWatches(db.pool, withTrain('cancelled'), now);
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
-- Cheap scheduled checks through P4's Travel.status, for things a trip has booked: a flight by its number,
-- a train ticket by its PNR. `query` is the StatusQuery sent as it is; `last_reading` is the last StatusResult.
create table watches (
  watch_id text primary key,
  trip_id text not null,
  kind text not null check (kind in ('flight', 'pnr')),
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
// apps/brain/src/watches/diff.ts
// Which change between two status readings is worth a nudge. Readings are P4's StatusResult as they are.
// Each change has a key: the same change is nudged once.
import type { Action } from '../proactive/policy.js';
import type { StatusQuery, StatusResult } from '../travel/travel.js';

/** What a watch checks: P4's status kinds, a flight by its number or a train ticket by its PNR. */
export type WatchKind = StatusQuery['kind'];

export interface WatchInfo {
  watchId: string;
  kind: WatchKind;
  label: string;
  /** Go already posted a notice for this watch, so a change can update it in place. */
  hasNotice: boolean;
  /** The watch concerns particular people (the booking's travellers), so a pin can reach just them. */
  hasPeople: boolean;
  /** When the watch stops: an hour after a flight lands, or when a train leaves. */
  endsAt: Date;
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
const H = 3600_000;

type Flight = Extract<StatusResult, { kind: 'flight' }>;
type Pnr = Extract<StatusResult, { kind: 'pnr' }>;

const urgencyIn = (hoursToGo: number): number => (hoursToGo <= 6 ? 0.9 : hoursToGo <= 24 ? 0.7 : 0.4);

function flightChange(w: WatchInfo, before: Flight | null, after: Flight, now: Date): WatchChange | null {
  // People act before the time they planned around, so urgency counts to the scheduled departure.
  const urgency = urgencyIn((Date.parse(after.scheduledDepartAt) - now.getTime()) / H);
  const posts: Action[] = w.hasPeople ? ['pin', 'message'] : ['message'];
  const facts: Record<string, unknown> = {
    state: after.state,
    delayMinutes: after.delayMinutes,
    scheduledDepartAt: after.scheduledDepartAt,
    expectedDepartAt: after.expectedDepartAt,
    ...(before ? { beforeDelayMinutes: before.delayMinutes, beforeState: before.state } : {}),
  };
  if (after.state === 'cancelled') {
    if (before?.state === 'cancelled') return null;
    return { changeKey: `${w.watchId}:cancelled`, importance: 1, confidence: 0.95, urgency, small: false, useful: posts, facts };
  }
  const step = Math.floor(after.delayMinutes / DELAY_STEP) * DELAY_STEP;
  const was = before ? Math.floor(before.delayMinutes / DELAY_STEP) * DELAY_STEP : 0;
  if (step >= DELAY_FLAG && step !== was) {
    const useful: Action[] = w.hasNotice ? ['update_card', ...posts] : posts;
    return { changeKey: `${w.watchId}:delay:${step}`, importance: step >= 60 ? 0.9 : 0.7, confidence: 0.95, urgency, small: false, useful, facts };
  }
  if (step < DELAY_FLAG && was >= DELAY_FLAG && w.hasNotice) {
    return { changeKey: `${w.watchId}:ontime:${after.expectedDepartAt}`, importance: 0.6, confidence: 0.95, urgency, small: false, useful: ['update_card'], facts };
  }
  return null;
}

function pnrChange(w: WatchInfo, before: Pnr | null, after: Pnr, now: Date): WatchChange | null {
  if (after.state === 'not_found' || after.state === before?.state) return null;
  const urgency = urgencyIn((w.endsAt.getTime() - now.getTime()) / H);
  const posts: Action[] = w.hasPeople ? ['pin', 'message'] : ['message'];
  const facts: Record<string, unknown> = { state: after.state, detail: after.detail, ...(before ? { beforeState: before.state } : {}) };
  if (after.state === 'cancelled') {
    return { changeKey: `${w.watchId}:cancelled`, importance: 1, confidence: 0.95, urgency, small: false, useful: posts, facts };
  }
  if (after.state === 'confirmed' && before?.state === 'waitlisted') {
    return { changeKey: `${w.watchId}:confirmed`, importance: 0.6, confidence: 0.95, urgency, small: false, useful: posts, facts };
  }
  return null;
}

export function diffReading(w: WatchInfo, before: StatusResult | null, after: StatusResult, now: Date): WatchChange | null {
  switch (after.kind) {
    case 'flight':
      return flightChange(w, before?.kind === 'flight' ? before : null, after, now);
    case 'pnr':
      return pnrChange(w, before?.kind === 'pnr' ? before : null, after, now);
  }
}
```

```ts
// apps/brain/src/watches/plan.ts
// Which watches a trip needs right now, kept in step with the trip on every change (level-triggered).
// A watch's query is P4's StatusQuery as it is.
import type pg from 'pg';
import type { Trip } from '../door/methods.js';
import type { StatusQuery } from '../travel/travel.js';

export interface WatchPlan {
  watchId: string;
  tripId: string;
  query: StatusQuery;
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
    if (b.status !== 'confirmed') continue;
    const j = b.journey;
    if (b.kind === 'flight') {
      if (!j || !j.carrier_code || !j.number) continue;
      const depart = Date.parse(j.depart_at);
      const arrive = Date.parse(j.arrive_at);
      if (arrive + H <= t) continue;
      out.push({
        watchId: `flight:${trip.trip_id}:${b.booking_id}`,
        tripId: trip.trip_id,
        query: { kind: 'flight', carrierCode: j.carrier_code, number: j.number, date: j.depart_at.slice(0, 10) },
        personIds: b.for_person_ids,
        label: `${j.carrier_name ? `${j.carrier_name} ` : ''}${j.carrier_code} ${j.number}`,
        startAt: new Date(Math.max(t, depart - 24 * H)),
        endsAt: new Date(arrive + H),
      });
    } else if (b.kind === 'train') {
      const leaves = Date.parse(j?.depart_at ?? b.starts_at ?? '');
      if (Number.isNaN(leaves) || leaves <= t) continue;
      out.push({
        watchId: `pnr:${trip.trip_id}:${b.booking_id}`,
        tripId: trip.trip_id,
        query: { kind: 'pnr', pnr: b.ref },
        personIds: b.for_person_ids,
        label: b.title,
        startAt: now,
        endsAt: new Date(leaves),
      });
    }
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
      [p.watchId, p.tripId, p.query.kind, JSON.stringify(p.query), p.personIds, p.label, p.startAt, p.endsAt],
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
git add apps/brain/src/db/migrations/5100_watches.sql apps/brain/src/watches/diff.ts apps/brain/src/watches/plan.ts apps/brain/src/watches/watches.test.ts
git commit -m "feat(watches): what a trip watches (booked flights and train tickets) and which change is worth a nudge

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `watches.test.ts` passes; earlier tests stay green.

### Task 8: The watch runner, the demo's "fire a watch", and wiring proactive into Go

**Files:**
- Create: `apps/brain/src/watches/runner.ts`
- Create: `apps/brain/src/watches/admin.ts`
- Create: `apps/brain/src/proactive/register.ts`
- Modify: `apps/brain/src/main.ts` (add `registerProactive` to `LANES`, after the lanes before it)
- Test: `apps/brain/src/watches/runner.test.ts`
- Test: `apps/brain/src/proactive/register.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 7; `Brain`, `RegisterLane` (P1); `Context.addTurnRules` and `Brain.onStop` (P1, master §6.3); `brain.travel?.status` with P4's `StatusQuery` and `StatusResult` (`travel/travel.ts`); `brain.door.link.request('read_trip')` (P1); `brain.env.ADMIN_TOKEN` (P7's variable, declared by P1).
- Produces:
  - `runner.ts`: `nextCheckIn(reading: StatusResult, endsAt: Date, now: Date): number` (ms); `backoffMs(errors): number`; `interface WatchRunnerDeps { pool; travel: Pick<Travel, 'status'> | null; store: ProactiveStore; now; log }`; `createWatchRunner(deps): { tick(): Promise<number> }` (returns how many changes became candidates). Candidate topics: `flight_status` and `pnr_status`.
  - `admin.ts`: `FireWatchBody` (zod, with `force` and `reset_budget`); `FIRE_WINDOW_MS = 60_000`; `fireKey(body, minute: number): string`; `interface FireDeps { adminToken: string | undefined; store: ProactiveStore; now: () => Date; promote: () => Promise<number> }`; `registerFireRoute(app: FastifyInstance, deps: FireDeps): void` (`POST /admin/watch/fire`, answering `{ ok, dedupe_key, promoted }`, plus `duplicate: true` for a repeat).
  - `register.ts`: `PROMOTE_EVERY_MS = 15_000`, `WATCH_EVERY_MS = 30_000`, `SWEEP_EVERY_MS = 600_000`, `ACTIVE_TRIP_DAYS = 90`; `interface ProactiveHandles { store; promote(): Promise<number>; checkWatches(): Promise<number>; sweep(): Promise<void>; stop(): void }`; `startProactive(brain, opts?: { intervals?: boolean; travel?: Pick<Travel, 'status'> | null }): Promise<ProactiveHandles>` (registers `composerRules` through `brain.context.addTurnRules` and its interval timers' stop through `brain.onStop`, the timers also `unref()`ed; logs one error line and throws at boot when P1 has no `addTurnRules`, before anything is registered); `registerProactive: RegisterLane`.

Decision: watches are registered by `registerProactive` (the master's boot order has `registerProactive` and `registerCalls`, no `registerWatches`, and watches only feed the proactive candidates). The code stays in `watches/`.

The demo's simulated watch (master §1 3:40 and §9): P7's admin page calls `POST /admin/watch/fire` with `Authorization: Bearer <ADMIN_TOKEN>` and a body such as `{ "trip_id": "t_goa", "label": "IndiGo 6E 2134", "person_ids": ["p_arjun"], "delay_minutes": 120, "arrive_at": "2026-11-06T22:45:00+05:30", "note": "Arjun's airport cab is booked for 9 pm" }` (`state` defaults to `delayed`, P4's word). It adds a `watch` candidate with `simulated: true` and runs the promoter at once, so the nudge reaches the desk within a second; without `force` it goes through the same bar as any watch. `reset_budget: true` (for rehearsals) first stops today's earlier unprompted posts counting, which also clears "two in a row".

On stage the admin page sends `force: true` (master §1 3:40 and §9): the real trip's earlier nudges, its daily budget and its hushes must not hold the beat back. `force` marks this one candidate `forced` (Task 1): it skips the bar, night, the daily budget, "two in a row", the hush raise and the ignored-nudge raise, and nothing else. The card still says "Simulated for the demo" (the candidate is `simulated`), it is still pinned only to the people named (never one who paused Go), and it still counts as a post of the day. A double click posts once: the candidate's key is made from the body (everything but `reset_budget`) and the minute it arrived, and the same body in that minute or the minute before answers `{ ok: true, duplicate: true, promoted: 0 }` without adding anything; the desk item's id comes from the key, so even two clicks at the same moment add one row (`add` is `on conflict do nothing`) and one desk item.

Decision (P4's `Travel.simulate`): the route keeps its own simulated candidate and does not call P4's `brain.travel.simulate.setFlightDelay(...)`. `simulate` exists only while the fake ixigo runs, and the stage may search on real ixigo; the beat is about Arjun's 9 pm cab, which no status reading carries, and Arjun is not on the Goa trip's booked flight (`b_flight` covers Rahul, Priya and Kabir); and the route's candidate is `simulated: true` by construction, so the notice always says "Simulated for the demo", while a delay set on the fake would reach the runner as an unlabelled real change. Without `force` the route goes through the same bar and budget as a real watch; with or without it, through the same promoter, wake text and notice tools. A builder can check the runner end to end on P4's fake (`setFlightDelay`, then `checkWatches()`); that path is for tests, never the stage.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/brain/src/watches/runner.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import { goaTrip, seedTrip } from '../proactive/fakes.js';
import { ProactiveStore } from '../proactive/store.js';
import type { StatusQuery, StatusResult } from '../travel/travel.js';
import { syncWatches } from './plan.js';
import { backoffMs, createWatchRunner, nextCheckIn } from './runner.js';

const START = new Date('2026-11-06T07:00:00Z'); // 5 h 45 min before the flight leaves
const SCHEDULED = '2026-11-06T18:15:00+05:30';
const flight = (delayMinutes: number): StatusResult => ({
  kind: 'flight',
  state: delayMinutes > 0 ? 'delayed' : 'scheduled',
  scheduledDepartAt: SCHEDULED,
  expectedDepartAt: new Date(Date.parse(SCHEDULED) + delayMinutes * 60_000).toISOString(),
  delayMinutes,
  checkedAt: START.toISOString(),
});

let db: Awaited<ReturnType<typeof withSchema>>;
let store: ProactiveStore;
beforeAll(async () => {
  db = await withSchema();
  store = new ProactiveStore(db.pool);
  await seedTrip(db.pool, 't_goa');
  await syncWatches(db.pool, goaTrip(), START); // the Goa trip books one flight and no train: one watch
});
afterAll(async () => {
  await db.drop();
});

describe('timing', () => {
  it('checks a flight more often as it gets close, and a train ticket by how soon the train leaves', () => {
    const lands = new Date('2026-11-06T16:15:00Z');
    expect(nextCheckIn(flight(0), lands, START)).toBe(20 * 60_000);
    expect(nextCheckIn(flight(0), lands, new Date('2026-11-06T10:00:00Z'))).toBe(5 * 60_000);
    const ticket: StatusResult = { kind: 'pnr', state: 'waitlisted', detail: 'WL 4', checkedAt: START.toISOString() };
    const leaves = new Date('2026-11-05T01:40:00Z');
    expect(nextCheckIn(ticket, leaves, new Date('2026-11-01T00:00:00Z'))).toBe(360 * 60_000);
    expect(nextCheckIn(ticket, leaves, new Date('2026-11-04T10:00:00Z'))).toBe(120 * 60_000);
    expect(nextCheckIn(ticket, leaves, new Date('2026-11-04T22:00:00Z'))).toBe(30 * 60_000);
    expect(backoffMs(1)).toBe(2 * 60_000);
    expect(backoffMs(10)).toBe(60 * 60_000);
  });
});

describe('createWatchRunner', () => {
  it('sends the stored P4 query as it is, turns a new delay into one candidate, never twice, and backs off on errors', async () => {
    let now = START;
    const asked: StatusQuery[] = [];
    const readings: Array<StatusResult | Error> = [flight(0), flight(120), flight(120), new Error('ixigo is down')];
    const travel = {
      status: async (q: StatusQuery): Promise<StatusResult> => {
        asked.push(q);
        const next = readings.shift();
        if (!next || next instanceof Error) throw next ?? new Error('no reading');
        return next;
      },
    };
    const runner = createWatchRunner({ pool: db.pool, travel, store, now: () => now, log: { warn: () => {} } });

    expect(await runner.tick()).toBe(0); // on time: nothing
    expect(asked[0]).toEqual({ kind: 'flight', carrierCode: '6E', number: '2134', date: '2026-11-06' });
    now = new Date(START.getTime() + 20 * 60_000);
    expect(await runner.tick()).toBe(1); // 2 h late
    const c = await store.status('t_goa', 'flight:t_goa:b_flight:delay:120');
    expect(c?.status).toBe('pending');
    const facts = await db.pool.query<{ topic: string; facts: Record<string, unknown>; person_ids: string[]; useful: string[] }>(
      `select topic, facts, person_ids, useful from proactive_candidates where dedupe_key = 'flight:t_goa:b_flight:delay:120'`,
    );
    expect(facts.rows[0]).toMatchObject({
      topic: 'flight_status',
      person_ids: ['p_rahul', 'p_priya', 'p_kabir'],
      useful: ['pin', 'message'],
      facts: { watchId: 'flight:t_goa:b_flight', label: 'IndiGo 6E 2134', state: 'delayed', delayMinutes: 120, checkedAt: START.toISOString() },
    });

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
    const runner = createWatchRunner({ pool: db.pool, travel: { status: async () => flight(0) }, store, now: () => late, log: { warn: () => {} } });
    await runner.tick();
    const w = await db.pool.query<{ active: boolean }>(`select active from watches where watch_id = 'flight:t_goa:b_flight'`);
    expect(w.rows[0]?.active).toBe(false);
    expect(await createWatchRunner({ pool: db.pool, travel: null, store, now: () => late, log: { warn: () => {} } }).tick()).toBe(0);
  });
});
```

```ts
// apps/brain/src/proactive/register.test.ts
import { Event } from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import { candidate, fakeBrain, goaPack, goaTrip, manualTime, seedTrip, turnCtx } from './fakes.js';
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
  it('registers its hooks, the turn rules, wake renderers, the openings block and the notice tools', async () => {
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now, env: { ADMIN_TOKEN: TOKEN } });
    const h = await startProactive(brain, { intervals: false, travel: null });
    expect(reg.tools.map((t) => t.name)).toEqual(['post_notice', 'update_notice']);
    expect([...reg.wakes.keys()]).toEqual(['timer', 'watch', 'opening']);
    expect(reg.nows.map((n) => n.name)).toEqual(['openings']);
    expect(reg.turnRules).toHaveLength(1);
    expect(reg.stops).toHaveLength(1); // its timers stop when Go stops
    expect(reg.onRead).toHaveLength(1);
    expect(reg.onEvent).toHaveLength(1);
    h.stop();
  });

  it('refuses to start, loudly, when P1 cannot limit a proactive turn', async () => {
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now });
    delete (brain.context as { addTurnRules?: unknown }).addTurnRules;
    await expect(startProactive(brain, { intervals: false, travel: null })).rejects.toThrow(/addTurnRules/);
    expect(reg.tools).toEqual([]);
    expect(reg.onRead).toEqual([]);
  });

  it('plays the 3:40 demo beat: a simulated delay pinned to Arjun, labelled, within one pass', async () => {
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain, app, reg, desk, link } = fakeBrain({ pool: db.pool, now: time.now, env: { ADMIN_TOKEN: TOKEN } });
    await startProactive(brain, { intervals: false, travel: null });

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
    // What P1's turn gets for this item: a pin through post_notice, reading, stay_silent, and no text message.
    expect(reg.turnRules[0]!([item])).toEqual({ tools: expect.arrayContaining(['post_notice', 'stay_silent']), mayPostText: false });
    expect(reg.turnRules[0]!([item])?.tools).not.toContain('call_business');
    const wakeText = reg.wakes.get('watch')!(item, goaPack());
    expect(wakeText).toContain('Simulated for the demo');
    expect(wakeText).toContain('running 120 minutes late');

    const post = reg.tools.find((t) => t.name === 'post_notice')!;
    const ctx = turnCtx({ link, pack: goaPack(), wake: [item] });
    await post.run(post.input.parse({ tone: 'heads_up', title: 'Your flight is 2 hours late', body: 'You now land at 10:45 pm, but your cab is at 9. Want me to move it to 11?' }), ctx);
    const card = ctx.cards[0] as Record<string, unknown>;
    expect(card).toMatchObject({ kind: 'notice', for_person_ids: ['p_arjun'], source: { name: 'Simulated for the demo' } });

    // A double click sends the same fire again: it posts once.
    const again = (await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: fire })).json();
    expect(again).toMatchObject({ ok: true, duplicate: true, promoted: 0, dedupe_key: res.json().dedupe_key });
    // Another nudge three minutes later, with nobody speaking since, is "two in a row": it waits. A rehearsal resets the budget first.
    time.advance(3 * 60_000);
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...fire, delay_minutes: 150 } })).json()).toMatchObject({ promoted: 0 });
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...fire, delay_minutes: 180, reset_budget: true } })).json()).toMatchObject({ promoted: 1 });
  });

  it('the stage fire (force: true) reaches the desk once and pins one labelled notice to Arjun, with the budget spent and a hush on; without force it is held', async () => {
    await seedTrip(db.pool, 't_stage');
    const time = manualTime('2026-10-06T06:30:00Z');
    const pack = goaPack({ trip: goaTrip({ trip_id: 't_stage' }) });
    const { brain, app, reg, desk, link } = fakeBrain({ pool: db.pool, now: time.now, env: { ADMIN_TOKEN: TOKEN }, pack });
    const h = await startProactive(brain, { intervals: false, travel: null });
    // The real trip's day so far: three unprompted posts (nobody has spoken since), a hush and an ignored nudge.
    for (let i = 0; i < 3; i += 1) {
      const c = candidate({ tripId: 't_stage', dedupeKey: `spent:${i}` });
      await h.store.add(c);
      await h.store.promote(c, { allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true, localDay: '2026-10-06' }, new Date(time.now().getTime() - (i + 1) * 600_000));
    }
    await h.store.hush('t_stage', time.now());
    await h.store.ignored('t_stage', time.now());
    const auth = { authorization: `Bearer ${TOKEN}` };
    const stage = { ...fire, trip_id: 't_stage' };

    const held = (await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: stage })).json();
    expect(held).toMatchObject({ ok: true, promoted: 0 });
    expect(await h.store.status('t_stage', held.dedupe_key)).toMatchObject({ status: 'pending', reason: 'budget' });
    expect(desk.items).toHaveLength(0);

    const forced = (await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...stage, force: true } })).json();
    expect(forced).toMatchObject({ ok: true, promoted: 1 });
    expect(forced.dedupe_key).not.toBe(held.dedupe_key);
    // The operator's double click.
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...stage, force: true } })).json()).toMatchObject({ duplicate: true, promoted: 0 });
    expect(desk.items).toHaveLength(1);

    const item = desk.items[0]!;
    expect(proactiveOf(item)).toMatchObject({ allowed: ['pin'], forPersonIds: ['p_arjun'], candidate: { simulated: true, forced: true } });
    const post = reg.tools.find((t) => t.name === 'post_notice')!;
    const ctx = turnCtx({ link, pack, wake: [item] });
    await post.run(post.input.parse({ tone: 'heads_up', title: 'Your flight is 2 hours late', body: 'You now land at 10:45 pm, but your cab is at 9. Want me to move it to 11?' }), ctx);
    expect(ctx.cards).toHaveLength(1);
    expect(ctx.cards[0]).toMatchObject({ kind: 'notice', for_person_ids: ['p_arjun'], source: { name: 'Simulated for the demo' } });
    expect(await h.store.status('t_stage', forced.dedupe_key)).toMatchObject({ status: 'promoted', counted: true });
  });

  it('plans timers and watches when a trip is created, and the sweep re-plans them', async () => {
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now });
    const h = await startProactive(brain, { intervals: false, travel: null });
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
// Scheduled cheap checks. Each due watch sends its stored StatusQuery to P4's Travel.status as it is, compares
// the answer with its last reading, and a change worth a nudge becomes a proactive candidate keyed by the
// change, so the same change is never nudged twice.
import type pg from 'pg';
import type { Candidate } from '../proactive/policy.js';
import type { ProactiveStore } from '../proactive/store.js';
import type { StatusQuery, StatusResult, Travel } from '../travel/travel.js';
import { diffReading, type WatchChange, type WatchKind } from './diff.js';

type WatchRow = {
  watch_id: string;
  trip_id: string;
  kind: WatchKind;
  query: StatusQuery;
  person_ids: string[];
  label: string;
  last_reading: StatusResult | null;
  last_change_key: string | null;
  ends_at: Date;
  errors: number;
  notice_card_id: string | null;
};

const MIN = 60_000;
/** The proactive topic for each watch kind; the wake text (Task 5) reads these. */
const TOPIC: Readonly<Record<WatchKind, string>> = { flight: 'flight_status', pnr: 'pnr_status' };

export function nextCheckIn(reading: StatusResult, endsAt: Date, now: Date): number {
  if (reading.kind === 'flight') {
    const hours = (Date.parse(reading.expectedDepartAt) - now.getTime()) / 3600_000;
    if (hours <= 3) return 5 * MIN;
    if (hours <= 24) return 20 * MIN;
    return 120 * MIN;
  }
  // A train ticket's watch ends when the train leaves.
  const hours = (endsAt.getTime() - now.getTime()) / 3600_000;
  if (hours <= 6) return 30 * MIN;
  if (hours <= 48) return 120 * MIN;
  return 360 * MIN;
}

export function backoffMs(errors: number): number {
  return Math.min(60, 2 ** errors) * MIN;
}

function toCandidate(w: WatchRow, change: WatchChange, reading: StatusResult, now: Date): Candidate {
  return {
    tripId: w.trip_id,
    dedupeKey: change.changeKey,
    source: 'watch',
    topic: TOPIC[w.kind],
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
  /** P4's travel layer; null turns watches off. */
  travel: Pick<Travel, 'status'> | null;
  store: ProactiveStore;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
}

export function createWatchRunner(d: WatchRunnerDeps): { tick(): Promise<number> } {
  let running: Promise<number> | null = null;

  async function once(): Promise<number> {
    const travel = d.travel;
    if (!travel) return 0;
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
      let reading: StatusResult;
      try {
        reading = await travel.status(w.query);
      } catch (err) {
        const errors = w.errors + 1;
        d.log.warn({ err, watchId: w.watch_id }, 'watches: a check failed; backing off');
        await d.pool.query(
          `update watches set errors = $2, last_error = $3, next_check_at = $4 where watch_id = $1`,
          [w.watch_id, errors, (err instanceof Error ? err.message : String(err)).slice(0, 300), new Date(now.getTime() + backoffMs(errors))],
        );
        continue;
      }
      const change = diffReading(
        { watchId: w.watch_id, kind: w.kind, label: w.label, hasNotice: w.notice_card_id !== null, hasPeople: w.person_ids.length > 0, endsAt: w.ends_at },
        w.last_reading,
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
        [w.watch_id, JSON.stringify(reading), lastKey, new Date(now.getTime() + nextCheckIn(reading, w.ends_at, now))],
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
// POST /admin/watch/fire: the demo's simulated watch. Without force it goes through the same bar as a real one; with
// force (the stage) it skips the bar, the budget, "two in a row" and the hush for this nudge only. Every card Go posts
// from it says "Simulated for the demo", and a double click posts once.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localDay } from '../proactive/clock.js';
import type { Candidate } from '../proactive/policy.js';
import type { ProactiveStore } from '../proactive/store.js';

/** The same fire within this window (or the one before) is a double click. */
export const FIRE_WINDOW_MS = 60_000;

export const FireWatchBody = z.object({
  trip_id: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  person_ids: z.array(z.string().min(1).max(64)).max(30).default([]),
  /** P4's flight status words. */
  state: z.enum(['scheduled', 'delayed', 'cancelled', 'departed', 'landed']).default('delayed'),
  delay_minutes: z.int().min(0).max(1440).default(120),
  arrive_at: z.iso.datetime({ offset: true }).optional(),
  note: z.string().min(1).max(200).optional(),
  importance: z.number().min(0).max(1).default(0.9),
  urgency: z.number().min(0).max(1).default(0.9),
  /** Rehearsals: today's earlier unprompted posts stop counting first. */
  reset_budget: z.boolean().default(false),
  /** The stage: this nudge skips the bar, the budget, "two in a row", hush and ignored raises. Still labelled and pinned. */
  force: z.boolean().default(false),
});
type FireWatch = z.infer<typeof FireWatchBody>;

/** The candidate's key: the body (all but reset_budget) and the minute it arrived, so a double click maps to one key. */
export function fireKey(b: FireWatch, minute: number): string {
  const what = JSON.stringify([b.trip_id, b.label, b.person_ids, b.state, b.delay_minutes, b.arrive_at ?? null, b.note ?? null, b.importance, b.urgency, b.force]);
  return `sim:flight_status:${createHash('sha256').update(what).digest('hex').slice(0, 12)}:${minute}`;
}

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
    const minute = Math.floor(now.getTime() / FIRE_WINDOW_MS);
    const dedupeKey = fireKey(b, minute);
    // A double click that straddles a minute: the same fire a moment ago is in the minute before.
    const earlier = fireKey(b, minute - 1);
    if (await d.store.status(b.trip_id, earlier)) return reply.send({ ok: true, dedupe_key: earlier, duplicate: true, promoted: 0 });
    if (await d.store.status(b.trip_id, dedupeKey)) return reply.send({ ok: true, dedupe_key: dedupeKey, duplicate: true, promoted: 0 });
    if (b.reset_budget) await d.store.resetBudget(b.trip_id, localDay(now, await d.store.tripTz(b.trip_id)));
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
        state: b.state,
        delayMinutes: b.delay_minutes,
        simulated: true,
        ...(b.arrive_at ? { arriveAt: b.arrive_at } : {}),
        ...(b.note ? { note: b.note } : {}),
      },
      simulated: true,
      small: false,
      ...(b.force ? { forced: true } : {}),
    };
    // Two clicks at the same moment: one insert wins, the other is the double click.
    if ((await d.store.add(c)) === 'exists') return reply.send({ ok: true, dedupe_key: dedupeKey, duplicate: true, promoted: 0 });
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
import type { Travel } from '../travel/travel.js';
import { registerFireRoute } from '../watches/admin.js';
import { noteWatchNotice, syncWatches } from '../watches/plan.js';
import { createWatchRunner } from '../watches/runner.js';
import { composerRules } from './allowed.js';
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
  /** Overrides `brain.travel` for the watches; null turns watches off. */
  travel?: Pick<Travel, 'status'> | null;
}

export async function startProactive(brain: Brain, opts: StartProactiveOpts = {}): Promise<ProactiveHandles> {
  // The bar's limits are enforced by P1's turn (master §6.3: Context.addTurnRules). Without it a proactive
  // turn could post or act beyond what the bar allowed, so refuse to start, before anything is registered.
  if (typeof brain.context.addTurnRules !== 'function') {
    const why = 'proactive: P1 has no Context.addTurnRules (master §6.3), so the bar cannot limit proactive turns; not starting';
    brain.log.error(why);
    throw new Error(why);
  }
  const store = new ProactiveStore(brain.pool);
  const log = brain.log;
  const promoter = createPromoter({ store, desk: brain.desk, packs: brain.packs, now: brain.now, log });
  const travel = opts.travel !== undefined ? opts.travel : (brain.travel ?? null);
  const watches = createWatchRunner({ pool: brain.pool, travel, store, now: brain.now, log });
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
  brain.context.addTurnRules(composerRules);
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

  const stop = (): void => {
    for (const h of handles.splice(0)) clearInterval(h);
  };
  // When Go stops (master §6.3: Brain.onStop), the promoter, the watch checks and the sweep stop with it.
  brain.onStop(stop);

  return {
    store,
    promote: () => promoter.tick(),
    checkWatches: () => watches.tick(),
    sweep,
    stop,
  };
}

export const registerProactive: RegisterLane = async (brain) => {
  await startProactive(brain);
};
```

Edit `apps/brain/src/main.ts`: add the import below with the other lane imports, then insert `registerProactive` into the `LANES` array in master §6.3 order (after `registerMoney` when it is there, otherwise after the last lane in the array; always before `registerCalls` and `registerAdmin`):
```ts
import { registerProactive } from './proactive/register.js';
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/watches/runner.ts apps/brain/src/watches/admin.ts apps/brain/src/proactive/register.ts apps/brain/src/main.ts apps/brain/src/watches/runner.test.ts apps/brain/src/proactive/register.test.ts
git commit -m "feat(proactive): watch checks, the demo's simulated watch, and proactive Go wired into the service

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `runner.test.ts` and `register.test.ts` pass (including the 3:40 demo beat, the double click, and the forced stage fire past a spent budget and a hush); earlier tests stay green.

### Task 9: Call foundations (settings, the allowlist, "stop" in Hinglish, the call row)

**Files:**
- Create: `apps/brain/src/db/migrations/5200_calls.sql`
- Create: `apps/brain/src/calls/config.ts`
- Modify: `apps/brain/src/calls/env.ts` (P1's stub, taken over: adds `CALLS_VOICE_MODEL`; the allowlist comment names the `Name=+E164` form)
- Modify: `apps/brain/.env.example` (the P6 block gains `CALLS_VOICE_MODEL`; P1 Task 17's test checks that every key of `Env` is named there)
- Create: `apps/brain/src/calls/stop-words.ts`
- Create: `apps/brain/src/calls/store.ts`
- Test: `apps/brain/src/calls/foundation.test.ts`

P6 adds no proactive or watch variables, so P1's `proactive/env.ts` and `watches/env.ts` stubs stay empty; P6 takes over `calls/env.ts` and creates no new env file.

**Interfaces:**
- Consumes: `withSchema()` (P1); `Env` fields `GO_PUBLIC_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `OPENAI_API_KEY`, `CALLS_ALLOWLIST` (P1 declares them optional in `calls/env.ts`). This task adds `CALLS_VOICE_MODEL` to that file; the lane reads them all through `brain.env`.
- Produces:
  - `config.ts`: `CALL_WINDOW_MS = 30_000`, `CALL_CAP_MS = 240_000`, `RING_TIMEOUT_S = 30`, `TWILIO_TIME_LIMIT_S = 255`, `CARD_GAP_MS = 3_000`, `REALTIME_URL`, `LIVE_URL`, `REALTIME_MODEL = 'gpt-realtime-2.1'` (the default voice model), `REALTIME_VOICE = 'marin'` (a voice both models have), `VOICE_MODEL`, `isVoiceModel(model): boolean` (a `gpt-realtime` or `gpt-live` model, never a transcriber), `type VoiceKind = 'realtime' | 'live'`, `voiceKind(model): VoiceKind`, `E164`; `interface Callee { name: string | null; phone: string }`; `interface CallsEnvInput`; `interface CallsConfig { publicUrl; accountSid; authToken; from; openaiKey: string | null; voiceModel: string; allowlist: Callee[]; missing: string[] }`; `normalisePhone(raw): string | null`; `parseAllowlist(raw): Callee[]`; `loadCallsConfig(env): CallsConfig`; `findCallee(cfg, { business, phone? }): Callee | null`; `statusUrl(publicUrl, callId)`; `mediaUrl(publicUrl, callId)`; `maskPhone(phone)`. There is no transcription model anywhere in calls.
  - `env.ts`: `CallsEnv` gains `CALLS_VOICE_MODEL` (optional; refused at boot unless `isVoiceModel`).
  - `stop-words.ts`: `saysStop(text, repliesToCallLine: boolean): boolean`.
  - `store.ts`: `type CallState = 'waiting' | 'cancelled' | 'dialing' | 'talking' | 'ended' | 'failed'`; `interface CallLine { who: 'go' | 'them'; text: string }`; `interface RecordAsk { kind: 'agreed' | 'open'; text: string }`; `interface CallRow` (camelCase of the table); `interface NewCall`; `class CallStore` with `create`, `get`, `byCard`, `liveFor`, `recentlyCancelled`, `announced`, `cancel`, `dueToDial`, `startDialing`, `dialInfo`, `claimMedia`, `talking`, `end`, `inCall`, `toCloseOut`, `closedOut`.

`CALLS_ALLOWLIST` entries are `+E164` or `Name=+E164` (for example `Villa Sol=+919800000001,+919800000002`). A name lets the composer call by the business's name, and the "Go can phone" block (Task 13) lists names only, never numbers. Every state change is a single conditional `update ... where state = any(...)`, so two paths racing (the status callback and the media socket closing) end a call once.

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/calls/foundation.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../db/test-db.js';
import { findCallee, loadCallsConfig, maskPhone, mediaUrl, normalisePhone, parseAllowlist, statusUrl, voiceKind } from './config.js';
import { CallsEnv } from './env.js';
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

  it('picks the voice model: gpt-realtime-2.1 unless the day-one A/B says gpt-live-1, and never a transcriber', () => {
    expect(loadCallsConfig({}).voiceModel).toBe('gpt-realtime-2.1');
    expect(loadCallsConfig({ CALLS_VOICE_MODEL: 'gpt-live-1' }).voiceModel).toBe('gpt-live-1');
    expect(loadCallsConfig({ CALLS_VOICE_MODEL: 'gpt-4o-mini-transcribe' }).voiceModel).toBe('gpt-realtime-2.1');
    expect(voiceKind('gpt-realtime-2.1')).toBe('realtime');
    expect(voiceKind('gpt-live-1')).toBe('live');
    expect(CallsEnv.safeParse({ CALLS_VOICE_MODEL: 'gpt-live-1' }).success).toBe(true);
    expect(CallsEnv.safeParse({ CALLS_VOICE_MODEL: 'gpt-realtime-2.1-mini' }).success).toBe(true);
    for (const m of ['gpt-4o-mini-transcribe', 'gpt-realtime-transcribe', 'whisper-1']) {
      expect(CallsEnv.safeParse({ CALLS_VOICE_MODEL: m }).success, m).toBe(false);
    }
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
    const ended = await store.end('call_1', { state: 'ended', at, outcome: '10 am is fine.', reported: true, record: { kind: 'agreed', text: 'Check-in at 10 am is fine' }, transcript: [{ who: 'go', text: 'So, check-in at 10 am is fine. Thank you!' }], reason: 'hangup' });
    expect(ended).toMatchObject({ state: 'ended', reported: true, record: { kind: 'agreed' }, transcript: [{ who: 'go', text: 'So, check-in at 10 am is fine. Thank you!' }] });
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
-- Phone calls Go makes for a trip. Only Go's own lines are kept as the transcript; audio never is.
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
// Calls: the settings, the allowlist, phone numbers, the public URLs, the voice model and the fixed numbers.
export const CALL_WINDOW_MS = 30_000;
export const CALL_CAP_MS = 240_000;
export const RING_TIMEOUT_S = 30;
/** Twilio's own hard limit, a backstop behind Go's 4 minute cap. */
export const TWILIO_TIME_LIMIT_S = 255;
export const CARD_GAP_MS = 3_000;
export const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
/** gpt-live-1 over a plain WebSocket. Bash runs Live over WebRTC with a sideband, so the day-one check proves this URL. */
export const LIVE_URL = 'wss://api.openai.com/v1/live';
/** The default voice model: it has the "caller started speaking" event barge-in needs, and function tools. */
export const REALTIME_MODEL = 'gpt-realtime-2.1';
/** A voice both models have. */
export const REALTIME_VOICE = 'marin';
export const VOICE_MODEL = /^gpt-(realtime|live)(-[a-z0-9.]+)*$/;
/** A voice model, never a transcriber: Go hears with the voice model's own ears only (Keshav's ruling). */
export const isVoiceModel = (model: string): boolean => VOICE_MODEL.test(model) && !/transcri/i.test(model);
export type VoiceKind = 'realtime' | 'live';
export const voiceKind = (model: string): VoiceKind => (model.startsWith('gpt-live') ? 'live' : 'realtime');
export const E164 = /^\+[1-9]\d{6,14}$/;

export interface Callee { name: string | null; phone: string }

export interface CallsEnvInput {
  GO_PUBLIC_URL?: string | undefined;
  TWILIO_ACCOUNT_SID?: string | undefined;
  TWILIO_AUTH_TOKEN?: string | undefined;
  TWILIO_FROM?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  CALLS_ALLOWLIST?: string | undefined;
  CALLS_VOICE_MODEL?: string | undefined;
}

export interface CallsConfig {
  publicUrl: string | null;
  accountSid: string | null;
  authToken: string | null;
  from: string | null;
  openaiKey: string | null;
  /** CALLS_VOICE_MODEL when it names a voice model, else gpt-realtime-2.1. */
  voiceModel: string;
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
  const model = v(env.CALLS_VOICE_MODEL);
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
    voiceModel: model && isVoiceModel(model) ? model : REALTIME_MODEL,
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
// apps/brain/src/calls/env.ts (P1 created it with the calls variables optional; P6 adds the voice model)
import { z } from 'zod';
import { isVoiceModel } from './config.js';

/** P6: calls. All optional: call_business refuses while a setting is missing, and the room keeps working. */
export const CallsEnv = z.object({
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  CALLS_MODE: z.enum(['off', 'allowlist']).optional(),
  /** Who Go may call this week: comma-separated `+E164` or `Name=+E164`, e.g. "Villa Sol=+919800000001". */
  CALLS_ALLOWLIST: z.string().optional(),
  /** The voice model on a call: gpt-realtime-2.1 when unset, gpt-live-1 for the day-one A/B. Never a transcriber. */
  CALLS_VOICE_MODEL: z.string().refine(isVoiceModel, 'a gpt-realtime or gpt-live voice model, never a transcriber').optional(),
});
```

In `apps/brain/.env.example`, the P6 block becomes:
```bash
# P6: calls
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_FROM=
# OPENAI_API_KEY=
# CALLS_MODE=off
# CALLS_ALLOWLIST=              # e.g. "Villa Sol=+919800000001,+919800000002"; a name lets Go call by name
# CALLS_VOICE_MODEL=gpt-realtime-2.1   # gpt-live-1 for the day-one A/B; never a transcriber
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
git add apps/brain/src/db/migrations/5200_calls.sql apps/brain/src/calls/config.ts apps/brain/src/calls/env.ts apps/brain/.env.example apps/brain/src/calls/stop-words.ts apps/brain/src/calls/store.ts apps/brain/src/calls/foundation.test.ts
git commit -m "feat(calls): the allowlist, stop in English and Hinglish, and a call row that ends once

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `foundation.test.ts` passes; P1's `env-example.test.ts` stays green with `CALLS_VOICE_MODEL` named in `.env.example`; earlier tests stay green.

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

### Task 11: The live call (Twilio media socket to the voice model)

**Files:**
- Create: `apps/brain/src/calls/realtime.ts`
- Create: `apps/brain/src/calls/voice-wire.ts`
- Create: `apps/brain/src/calls/bridge.ts`
- Test: `apps/brain/src/calls/bridge.test.ts`

**Interfaces:**
- Consumes: `Schedule` (Task 1); `manualTime`, `waitFor` (Task 2); `CallLine` (Task 9); `REALTIME_URL`, `LIVE_URL`, `voiceKind`, `VoiceKind` (Task 9).
- Produces:
  - `realtime.ts`: `interface CallBrief { business; goal; factsAllowed: string[]; forWhom: string }`; `interface SessionSettings { model: string; voice: string }` (no transcription setting exists); `greeting(b): string`; `callInstructions(b, kind: VoiceKind): string`; `REPORT_OUTCOME_TOOL`; `ReportedOutcome` (zod: `{ outcome: string 1..500; answered: boolean; record?: { kind: 'agreed' | 'open'; text: string 1..200 } | null }`) and its type; `openVoice(o: { model; apiKey }): WebSocket`.
  - `voice-wire.ts`: `type VoiceEvent` (`audio`, `go_line`, `caller_started`, `report`, `response_started`, `response_done`, `error`); `interface VoiceWire { kind; bargeIn: 'model' | 'energy'; start(b, s); appendAudio(audio); speakFirst(b); truncate(itemId, playedMs); answerReport(ref, ok); wrapUp(); read(ev): VoiceEvent[]; flush(): VoiceEvent[] }`; `realtimeWire(): VoiceWire`; `liveWire(): VoiceWire`; `wireFor(model): VoiceWire` (a fresh wire per call).
  - `bridge.ts`: `type EndReason = 'hangup' | 'cap' | 'error'`; `interface BridgeHooks { talking(callId): Promise<void>; line(callId, line: CallLine): void /* Go's lines only */; outcome(callId, o: ReportedOutcome): void; ended(callId, reason: EndReason): Promise<void> }`; `interface BridgeDeps { claim(callId, token): Promise<CallBrief | null>; openVoice(): WebSocket; hangUp(callId): Promise<void>; hooks: BridgeHooks; schedule: Schedule; capMs: number; session: SessionSettings; log }`; `GREET_AFTER_MS = 4_000`, `WRAP_UP_BEFORE_MS = 20_000`, `HANG_UP_AFTER_GOODBYE_MS = 2_500`, `HANG_UP_AFTER_REPORT_MS = 15_000`, `BARGE_IN_LEVEL = 1_500`, `BARGE_IN_FRAMES = 3`; `frameLevel(payload): number`; `attachBridge(twilio: WebSocket, callId: string, deps: BridgeDeps): void`.

How a call runs (research/hands.md §4c, §4d; Keshav's "no second ear" ruling):
1. Twilio connects to `/calls/media/<call_id>` and sends `connected`, then `start` with `customParameters.token`. Nothing else happens until `claim` accepts the one-use token; a wrong token closes the socket with 1008 and ends nothing (an attacker who guesses a call id cannot end a real call).
2. The bridge opens the voice model's socket (`CALLS_VOICE_MODEL`, Task 9) and starts the session with `audio/pcmu` in and out (Twilio's 8 kHz μ-law passes through byte for byte) and Go's instructions. **No input transcription is turned on and no speech-to-text service is called**: Go hears with the voice model's own ears only. On `gpt-realtime-2.1` (the default) that is a `session.update` with server voice activity detection and the `report_outcome` tool, and no `audio.input.transcription`. On `gpt-live-1` (the day-one A/B) it is a `session.start` with `delegation: { type: 'client' }`: the Live model has no function tools and hands off instead.
3. Go waits for the business to say hello; if nobody speaks in 4 s, Go speaks first (realtime: `response.create`; Live: Go's greeting as `session.commentary.append`).
4. Twilio `media` frames go to the model (`input_audio_buffer.append` or `session.input_audio.append`); model audio deltas go back as Twilio `media` frames.
5. **Barge-in.** Realtime: on `input_audio_buffer.speech_started` (voice activity detection, which needs no transcription), the bridge sends Twilio `clear` (drop Go's queued audio) and the model `conversation.item.truncate` at the milliseconds already played (Twilio's media timestamps). Live has no "caller started speaking" event, so the bridge sends a Twilio `mark` after each chunk of Go's audio (Twilio echoes a mark once the audio before it has played, and echoes all pending marks after a `clear`); when three 20 ms frames in a row from the business are loud (`BARGE_IN_LEVEL`, root mean square of the decoded samples) while a mark is still pending, it sends Twilio `clear`. The Live model hears the business itself and yields. The level is tuned on day one (a speakerphone that leaks Go's own voice back could trip it).
6. **The card shows Go's side.** Go's lines come from the model's own output transcript (realtime `response.output_audio_transcript.done`; Live `session.output_transcript.delta` words, a line ending when the business starts talking, at a hand-off, or at the end of the call) and go to `hooks.line` as `who: 'go'`. The business's words never reach the card or `calls.transcript`: realtime has no transcript of them, and the Live wire reads its own input transcript only as "Go's line is over", never its text. The room hears the business on the speaker; the outcome comes from the model's report. Showing the business's words would need Keshav's explicit OK (and would only be possible on `gpt-live-1`, whose input transcript is the model's own; on realtime it would need a transcriber, which the ruling forbids).
7. **The outcome.** Realtime: `report_outcome` is answered "Noted. Now thank them and say goodbye.", and the goodbye response's end hangs up 2.5 s later. Live: Go says the answer back in one sentence that starts "So," and hands off; the bridge takes that line as the outcome (`answered: true`, no record line on this model), answers the hand-off quietly (`session.thinking.append`), and hangs up 2.5 s after Twilio has echoed the goodbye's last mark. Every report and every hand-off gets an answer (an unanswered Live hand-off leaves the voice improvising), and a hand-off that is not a read-back is answered "carry on". Either model: 15 s after the report at the latest.
8. At 3:40 the model is told to wrap up (realtime: a system item and `response.create`; Live: `session.instructions.append`); at 4:00 the bridge hangs up whatever happens. A dropped model socket hangs up too.

Event names: the GA realtime ones, with the older beta names (`response.audio.delta`, `response.audio_transcript.done`) accepted as well. The Live names are the ones Bash's live line uses in production (`session.output_transcript.delta`, `session.input_transcript.delta`, `session.delegation.created`, `session.thinking.append`, `session.instructions.append`, `session.commentary.append`), plus `session.start`, `session.input_audio.append` and `session.output_audio.delta` for the primary socket (research/hands.md §4c, read from the SDK's types). Two Live facts are unconfirmed and are what the day-one check (Task 14) proves before the A/B: the socket URL (`LIVE_URL`) and that `session.start` takes `audio.format: { type: 'audio/pcmu', rate: 8000 }`. Realtime stays the default because it has the speech-started event and function tools; the A/B on day one decides, and the choice is Keshav's.

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/calls/bridge.test.ts
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { manualTime, waitFor } from '../proactive/fakes.js';
import { attachBridge, BARGE_IN_LEVEL, frameLevel, type EndReason } from './bridge.js';
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
const quiet = Buffer.alloc(160, 0xff).toString('base64'); // one 20 ms frame of μ-law silence

const brief: CallBrief = { business: 'Villa Sol', goal: 'Ask if we can check in at 10 am on 6 Nov', factsAllowed: ['Group of five', 'Staying 6 to 9 November'], forWhom: 'a group of 5 friends travelling together' };
const startFrame = (token: string) => ({ event: 'start', sequenceNumber: '1', streamSid: 'MZ1', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { token }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } });

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function setup(model = 'gpt-realtime-2.1') {
  const time = manualTime('2026-10-06T10:00:00Z');
  const voice = new WebSocketServer({ port: 0 });
  const modelGot: Array<Record<string, any>> = [];
  let modelSocket: WebSocket | null = null;
  voice.on('connection', (ws) => {
    modelSocket = ws;
    ws.on('message', (data) => modelGot.push(JSON.parse(data.toString()) as Record<string, any>));
  });
  const voiceUrl = `ws://127.0.0.1:${(voice.address() as AddressInfo).port}`;
  const seen = { talking: [] as string[], lines: [] as CallLine[], outcomes: [] as ReportedOutcome[], ended: [] as EndReason[], hangUps: [] as string[] };

  const bridgeServer = new WebSocketServer({ port: 0 });
  bridgeServer.on('connection', (ws) =>
    attachBridge(ws, 'call_1', {
      claim: async (_id, token) => (token === 'tok' ? brief : null),
      openVoice: () => new WebSocket(voiceUrl),
      hangUp: async (id) => { seen.hangUps.push(id); },
      hooks: {
        talking: async (id) => { seen.talking.push(id); },
        line: (_id, line) => { seen.lines.push(line); },
        outcome: (_id, o) => { seen.outcomes.push(o); },
        ended: async (_id, reason) => { seen.ended.push(reason); },
      },
      schedule: time.schedule,
      capMs: 240_000,
      session: { model, voice: 'marin' },
      log: { warn: () => {} },
    }),
  );
  const twilio = new WebSocket(`ws://127.0.0.1:${(bridgeServer.address() as AddressInfo).port}`);
  const twilioGot: Array<Record<string, any>> = [];
  let closedWith: number | null = null;
  twilio.on('message', (data) => twilioGot.push(JSON.parse(data.toString()) as Record<string, any>));
  twilio.on('close', (code) => { closedWith = code; });
  await new Promise((resolve) => twilio.once('open', resolve));
  cleanups.push(() => { twilio.terminate(); voice.close(); bridgeServer.close(); });
  return {
    time, seen, modelGot, twilioGot,
    send: (frame: object) => twilio.send(JSON.stringify(frame)),
    fromModel: (event: object) => modelSocket?.send(JSON.stringify(event)),
    modelSocket: () => modelSocket,
    closedWith: () => closedWith,
  };
}

describe('frameLevel', () => {
  it('reads silence as 0 and a spoken-level tone well above the barge-in level', () => {
    expect(frameLevel(quiet)).toBe(0);
    expect(frameLevel(toneFrame(0))).toBeGreaterThan(BARGE_IN_LEVEL * 2);
  });
});

describe('attachBridge on gpt-realtime-2.1 (the default)', () => {
  it('bridges μ-law both ways with no transcriber, clears on barge-in, keeps Go\'s lines only and hangs up after the goodbye', async () => {
    const s = await setup();
    s.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    s.send(startFrame('tok'));
    await waitFor(() => s.seen.talking.length === 1 && s.modelGot.some((e) => e.type === 'session.update'));
    const update = s.modelGot.find((e) => e.type === 'session.update')!;
    expect(update.session.model).toBe('gpt-realtime-2.1');
    expect(update.session.audio.input.format).toEqual({ type: 'audio/pcmu' });
    expect(update.session.audio.output.format).toEqual({ type: 'audio/pcmu' });
    // No second ear: the session never asks for a transcript of the business.
    expect(update.session.audio.input).not.toHaveProperty('transcription');
    expect(JSON.stringify(update)).not.toMatch(/transcri/i);
    expect(update.session.tools[0].name).toBe('report_outcome');
    expect(update.session.instructions).toContain('an AI assistant');
    expect(update.session.instructions).toContain('Never pay');
    expect(update.session.instructions).not.toMatch(/openai|gpt/i);

    s.fromModel({ type: 'response.created', response: { id: 'resp_1' } });
    s.fromModel({ type: 'response.output_audio.delta', response_id: 'resp_1', item_id: 'item_1', delta: toneFrame(0) });
    await waitFor(() => s.twilioGot.some((f) => f.event === 'media'));
    expect(s.twilioGot.find((f) => f.event === 'media')).toEqual({ event: 'media', streamSid: 'MZ1', media: { payload: toneFrame(0) } });
    expect(s.twilioGot.some((f) => f.event === 'mark')).toBe(false); // marks are for the Live wire only

    const frames = [10, 11, 12].map(toneFrame);
    frames.forEach((payload, i) => s.send({ event: 'media', sequenceNumber: String(i + 2), streamSid: 'MZ1', media: { track: 'inbound', chunk: String(i + 1), timestamp: String(i * 20), payload } }));
    await waitFor(() => s.modelGot.filter((e) => e.type === 'input_audio_buffer.append').length === 3);
    expect(s.modelGot.filter((e) => e.type === 'input_audio_buffer.append').map((e) => e.audio)).toEqual(frames);

    s.fromModel({ type: 'input_audio_buffer.speech_started', audio_start_ms: 40, item_id: 'item_2' });
    await waitFor(() => s.twilioGot.some((f) => f.event === 'clear') && s.modelGot.some((e) => e.type === 'conversation.item.truncate'));
    expect(s.twilioGot.find((f) => f.event === 'clear')).toEqual({ event: 'clear', streamSid: 'MZ1' });
    expect(s.modelGot.find((e) => e.type === 'conversation.item.truncate')).toMatchObject({ item_id: 'item_1', content_index: 0, audio_end_ms: 40 });

    s.fromModel({ type: 'response.output_audio_transcript.done', item_id: 'item_1', transcript: 'Hi, this is Go, an AI assistant calling for a group of five.' });
    // Even if an account sent a transcript of the business, it would never reach the card.
    s.fromModel({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_2', transcript: 'Yes, check-in at 10 is fine.' });
    await waitFor(() => s.seen.lines.length === 1);

    s.fromModel({
      type: 'response.function_call_arguments.done', response_id: 'resp_3', item_id: 'item_3', call_id: 'fc_1', name: 'report_outcome',
      arguments: JSON.stringify({ outcome: 'Check-in at 10 am is fine.', answered: true, record: { kind: 'agreed', text: 'Early check-in at 10 am at Villa Sol is fine' } }),
    });
    await waitFor(() => s.seen.outcomes.length === 1 && s.modelGot.some((e) => e.type === 'conversation.item.create'));
    expect(s.modelGot.find((e) => e.type === 'conversation.item.create')).toMatchObject({ item: { type: 'function_call_output', call_id: 'fc_1' } });
    expect(s.seen.outcomes[0]).toMatchObject({ outcome: 'Check-in at 10 am is fine.', record: { kind: 'agreed' } });
    expect(s.seen.lines).toEqual([{ who: 'go', text: 'Hi, this is Go, an AI assistant calling for a group of five.' }]);

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

describe('attachBridge on gpt-live-1 (the day-one A/B)', () => {
  it('starts a Live session with no transcriber, clears Go on loud audio while it still plays, and keeps Go\'s lines only', async () => {
    const s = await setup('gpt-live-1');
    s.send(startFrame('tok'));
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.start'));
    const start = s.modelGot.find((e) => e.type === 'session.start')!;
    expect(start.session).toMatchObject({ model: 'gpt-live-1', audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } }, delegation: { type: 'client' } });
    expect(JSON.stringify(start)).not.toMatch(/transcri/i);
    expect(start.session.instructions).toContain('starts with "So,"');
    expect(start.session.instructions).not.toMatch(/openai|gpt/i);

    // Go speaks: each chunk of its audio goes to Twilio followed by a mark.
    s.fromModel({ type: 'session.output_transcript.delta', delta: 'Hi, this is Go, ' });
    s.fromModel({ type: 'session.output_transcript.delta', delta: 'an AI assistant calling for a group of five.' });
    s.fromModel({ type: 'session.output_audio.delta', delta: toneFrame(0) });
    await waitFor(() => s.twilioGot.some((f) => f.event === 'mark'));
    expect(s.twilioGot).toEqual([
      { event: 'media', streamSid: 'MZ1', media: { payload: toneFrame(0) } },
      { event: 'mark', streamSid: 'MZ1', mark: { name: 'go_1' } },
    ]);

    // Quiet frames from the business clear nothing; three loud ones while Go's audio still plays clear it.
    [quiet, quiet, quiet].forEach((payload, i) => s.send({ event: 'media', streamSid: 'MZ1', media: { timestamp: String(i * 20), payload } }));
    await waitFor(() => s.modelGot.filter((e) => e.type === 'session.input_audio.append').length === 3);
    expect(s.twilioGot.some((f) => f.event === 'clear')).toBe(false);
    [10, 11, 12].map(toneFrame).forEach((payload, i) => s.send({ event: 'media', streamSid: 'MZ1', media: { timestamp: String(60 + i * 20), payload } }));
    await waitFor(() => s.twilioGot.some((f) => f.event === 'clear'));
    expect(s.twilioGot.at(-1)).toEqual({ event: 'clear', streamSid: 'MZ1' });
    await waitFor(() => s.modelGot.filter((e) => e.type === 'session.input_audio.append').length === 6);

    // The business talks: Go's line is over and kept; their words are not.
    s.fromModel({ type: 'session.input_transcript.delta', delta: 'Yes, 10 is fine.', start_ms: 3000, end_ms: 4200 });
    await waitFor(() => s.seen.lines.length === 1);
    expect(s.seen.lines).toEqual([{ who: 'go', text: 'Hi, this is Go, an AI assistant calling for a group of five.' }]);
  });

  it('takes Go\'s read-back as the outcome, answers every hand-off, and hangs up once the goodbye has played', async () => {
    const s = await setup('gpt-live-1');
    s.send(startFrame('tok'));
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.start'));

    // A hand-off that is not a read-back is answered, and is not an outcome.
    s.fromModel({ type: 'session.output_transcript.delta', delta: 'Could you hold on a moment?' });
    s.fromModel({ type: 'session.delegation.created', delegation: { id: 'dl_1', target: 'client' }, offset_ms: 5000 });
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.thinking.append'));
    expect(s.modelGot.find((e) => e.type === 'session.thinking.append')).toMatchObject({ delegation_id: 'dl_1' });
    expect(s.seen.outcomes).toEqual([]);

    s.fromModel({ type: 'session.output_transcript.delta', delta: 'So, check-in at 10 am ' });
    s.fromModel({ type: 'session.output_transcript.delta', delta: 'on the 6th is fine.' });
    s.fromModel({ type: 'session.delegation.created', delegation: { id: 'dl_2', target: 'client' }, offset_ms: 9000 });
    await waitFor(() => s.seen.outcomes.length === 1 && s.modelGot.filter((e) => e.type === 'session.thinking.append').length === 2);
    expect(s.seen.outcomes[0]).toEqual({ outcome: 'Check-in at 10 am on the 6th is fine.', answered: true, record: null });
    expect(s.modelGot.filter((e) => e.type === 'session.thinking.append').at(-1)).toMatchObject({ delegation_id: 'dl_2', content: 'Noted. Now thank them and say goodbye.' });

    // The goodbye plays; once Twilio echoes its mark, Go hangs up 2.5 s later.
    s.fromModel({ type: 'session.output_transcript.delta', delta: 'Thank you so much, goodbye!' });
    s.fromModel({ type: 'session.output_audio.delta', delta: toneFrame(1) });
    await waitFor(() => s.twilioGot.some((f) => f.event === 'mark'));
    const mark = s.twilioGot.find((f) => f.event === 'mark')!;
    s.send({ event: 'mark', streamSid: 'MZ1', mark: mark.mark });
    await waitFor(() => s.time.pending() === 5); // greet, wrap-up, cap, report fallback, goodbye
    s.time.advance(2_500);
    expect(s.seen.hangUps).toEqual(['call_1']);
    await waitFor(() => s.seen.ended.length === 1);
    expect(s.seen.ended).toEqual(['hangup']);
    expect(s.seen.lines).toEqual([
      { who: 'go', text: 'Could you hold on a moment?' },
      { who: 'go', text: 'So, check-in at 10 am on the 6th is fine.' },
      { who: 'go', text: 'Thank you so much, goodbye!' },
    ]);
  });

  it('says its greeting first when nobody says hello', async () => {
    const s = await setup('gpt-live-1');
    s.send(startFrame('tok'));
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.start'));
    s.time.advance(4_000);
    await waitFor(() => s.modelGot.some((e) => e.type === 'session.commentary.append'));
    expect(s.modelGot.find((e) => e.type === 'session.commentary.append')).toMatchObject({
      delegation_id: null,
      content: 'Hi, this is Go, an AI assistant calling for a group of 5 friends travelling together.',
    });
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the modules do not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/brain/src/calls/realtime.ts
// What the voice model is told on a call, the one tool it has on gpt-realtime, and the socket to it.
import WebSocket from 'ws';
import { z } from 'zod';
import { LIVE_URL, REALTIME_URL, voiceKind, type VoiceKind } from './config.js';

export interface CallBrief { business: string; goal: string; factsAllowed: string[]; forWhom: string }
/** The voice model and its voice. There is no transcription setting: Go hears with the voice model's own ears only. */
export interface SessionSettings { model: string; voice: string }

/** Go's first line on every call: it says it is an AI assistant. */
export function greeting(b: CallBrief): string {
  return `Hi, this is Go, an AI assistant calling for ${b.forWhom}.`;
}

export function callInstructions(b: CallBrief, kind: VoiceKind): string {
  const facts = b.factsAllowed.length > 0 ? b.factsAllowed.map((f) => `- ${f}`).join('\n') : '- Nothing beyond the question itself.';
  const report = kind === 'realtime'
    ? '- As soon as you have the answer, or it is clear you cannot get it, call report_outcome with the outcome in one or two plain sentences. Then thank them and say goodbye.'
    : '- As soon as you have the answer, or it is clear you cannot get it, say it back to them in one short sentence that starts with "So," (for example "So, check-in at 10 am is fine."), then hand off (delegate). When you are told to, thank them and say goodbye.';
  return [
    `You are Go, an AI assistant, on a phone call to ${b.business} on behalf of ${b.forWhom}.`,
    `When they answer, say first: "${greeting(b)}" Then ask your question.`,
    `Your goal: ${b.goal}`,
    'Facts you may share if they help, and nothing else about the group:',
    facts,
    'Rules:',
    '- Never pay, never agree to pay, and never give card, bank, UPI or login details. If they ask for payment, say the group will pay separately.',
    '- Never share phone numbers, emails or anything not listed above.',
    '- Never say which company made you or which model you are. You are Go.',
    '- Be brief and polite. Short sentences. Speak English; if they answer in Hindi, speak Hindi.',
    '- If they ask you to hold, wait quietly.',
    report,
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

/** A plain WebSocket to the voice model (no SDK: the repo pins an older SDK for the copied agent loop). */
export function openVoice(o: { model: string; apiKey: string }): WebSocket {
  const headers = { Authorization: `Bearer ${o.apiKey}` };
  return voiceKind(o.model) === 'live'
    ? new WebSocket(LIVE_URL, { headers })
    : new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(o.model)}`, { headers });
}
```

```ts
// apps/brain/src/calls/voice-wire.ts
// The two voice models a call can use, behind one shape. A wire turns the bridge's few needs into the model's
// own events, and the model's events back into the few the bridge acts on. Neither wire turns on input
// transcription, and neither passes on the business's words: Go hears with the voice model's own ears only and
// the card shows Go's side (Keshav's ruling). One wire per call: the Live wire keeps Go's words between events.
import { voiceKind, type VoiceKind } from './config.js';
import { REPORT_OUTCOME_TOOL, callInstructions, greeting, type CallBrief, type SessionSettings } from './realtime.js';

/** What the bridge reads from the voice model. */
export type VoiceEvent =
  | { kind: 'audio'; itemId: string; audio: string }
  | { kind: 'go_line'; text: string }
  | { kind: 'caller_started' }
  | { kind: 'report'; ref: string; args: unknown }
  | { kind: 'response_started'; id: string }
  | { kind: 'response_done'; id: string }
  | { kind: 'error'; error: unknown };

export interface VoiceWire {
  kind: VoiceKind;
  /** 'model': the model says when the caller starts talking. 'energy': it does not, so the bridge uses Twilio marks and loudness. */
  bargeIn: 'model' | 'energy';
  start(b: CallBrief, s: SessionSettings): object;
  appendAudio(audio: string): object;
  speakFirst(b: CallBrief): object[];
  truncate(itemId: string, playedMs: number): object[];
  /** Every report or hand-off gets an answer; `ok` says whether its outcome was read. */
  answerReport(ref: string, ok: boolean): object[];
  wrapUp(): object[];
  read(ev: Record<string, unknown>): VoiceEvent[];
  /** Go's last unfinished line, at the end of the call. */
  flush(): VoiceEvent[];
}

const NOTED = 'Noted. Now thank them and say goodbye.';

function field(ev: Record<string, unknown>, key: string): string {
  const v = ev[key];
  return typeof v === 'string' ? v : '';
}

function responseId(ev: Record<string, unknown>): string {
  const r = ev.response as { id?: unknown } | undefined;
  return typeof r?.id === 'string' ? r.id : '';
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** gpt-realtime-2.1 (the default): server voice activity detection, function tools, no input transcription. */
export function realtimeWire(): VoiceWire {
  return {
    kind: 'realtime',
    bargeIn: 'model',
    start: (b, s) => ({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: s.model,
        instructions: callInstructions(b, 'realtime'),
        output_modalities: ['audio'],
        audio: {
          // No `transcription` key, on purpose: voice activity detection needs none, and Go keeps no second ear.
          input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad', silence_duration_ms: 500 } },
          output: { format: { type: 'audio/pcmu' }, voice: s.voice },
        },
        tools: [REPORT_OUTCOME_TOOL],
        tool_choice: 'auto',
      },
    }),
    appendAudio: (audio) => ({ type: 'input_audio_buffer.append', audio }),
    speakFirst: () => [{ type: 'response.create' }],
    truncate: (itemId, playedMs) => [{ type: 'conversation.item.truncate', item_id: itemId, content_index: 0, audio_end_ms: playedMs }],
    answerReport: (ref, ok) => [
      {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: ref, output: ok ? NOTED : 'That outcome could not be read. Call report_outcome again with a short outcome.' },
      },
      { type: 'response.create' },
    ],
    wrapUp: () => [
      {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Time is nearly up. Wrap up now: call report_outcome, then thank them and say goodbye.' }] },
      },
      { type: 'response.create' },
    ],
    read(ev) {
      switch (field(ev, 'type')) {
        case 'response.output_audio.delta':
        case 'response.audio.delta':
          return [{ kind: 'audio', itemId: field(ev, 'item_id'), audio: field(ev, 'delta') }];
        case 'input_audio_buffer.speech_started':
          return [{ kind: 'caller_started' }];
        case 'response.output_audio_transcript.done':
        case 'response.audio_transcript.done': {
          const line = field(ev, 'transcript').trim();
          return line ? [{ kind: 'go_line', text: line }] : [];
        }
        case 'response.function_call_arguments.done':
          return field(ev, 'name') === 'report_outcome' ? [{ kind: 'report', ref: field(ev, 'call_id'), args: parseJson(field(ev, 'arguments')) }] : [];
        case 'response.created':
          return [{ kind: 'response_started', id: responseId(ev) }];
        case 'response.done':
          return [{ kind: 'response_done', id: responseId(ev) }];
        case 'error':
          return [{ kind: 'error', error: ev.error }];
        default:
          // Everything else, including a transcript of the business should an account ever send one: never kept.
          return [];
      }
    },
    flush: () => [],
  };
}

/** gpt-live-1 (the day-one A/B): no function tools (it hands off instead), no speech-started event, and its
 *  transcripts are its own. Event names are the ones Bash's live line uses; the socket URL is proven on day one. */
export function liveWire(): VoiceWire {
  let words = '';
  let lastLine = '';
  let n = 0;
  const eventId = (tag: string): string => {
    n += 1;
    return `go_${tag}_${n}`;
  };
  const endLine = (): VoiceEvent[] => {
    const line = words.replace(/\s+/g, ' ').trim();
    words = '';
    if (!line) return [];
    lastLine = line;
    return [{ kind: 'go_line', text: line }];
  };
  /** Go says the answer back as "So, ..." just before it hands off; that line, without the "So,", is the outcome. */
  const readBack = (): string => {
    if (!/^so\b/i.test(lastLine)) return '';
    const said = lastLine.replace(/^so\b[,\s]*/i, '');
    return said.charAt(0).toUpperCase() + said.slice(1);
  };
  return {
    kind: 'live',
    bargeIn: 'energy',
    start: (b, s) => ({
      type: 'session.start',
      session: {
        model: s.model,
        instructions: callInstructions(b, 'live'),
        audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: s.voice } },
        delegation: { type: 'client' },
        store: false,
      },
    }),
    appendAudio: (audio) => ({ type: 'session.input_audio.append', audio }),
    speakFirst: (b) => [{ type: 'session.commentary.append', event_id: eventId('hello'), delegation_id: null, content: greeting(b) }],
    truncate: () => [],
    answerReport: (ref, ok) => [
      {
        type: 'session.thinking.append',
        event_id: eventId('noted'),
        delegation_id: ref,
        content: ok ? NOTED : 'If you have the answer, say it back to them in one sentence that starts with "So," and hand off again. If not, carry on with the goal.',
      },
    ],
    wrapUp: () => [
      {
        type: 'session.instructions.append',
        event_id: eventId('wrap'),
        delegation_id: null,
        content: 'Time is nearly up. Wrap up now: say the answer back in one sentence that starts with "So,", hand off, then thank them and say goodbye.',
      },
    ],
    read(ev) {
      switch (field(ev, 'type')) {
        case 'session.output_audio.delta':
          return [{ kind: 'audio', itemId: 'live', audio: field(ev, 'delta') }];
        case 'session.output_transcript.delta':
          words += field(ev, 'delta');
          return [];
        case 'session.input_transcript.delta':
          // The business is talking, so Go's line is over. Their words themselves are never kept.
          return endLine();
        case 'session.delegation.created': {
          const d = ev.delegation as { id?: unknown; target?: unknown } | undefined;
          if (typeof d?.id !== 'string' || d.target !== 'client') return [];
          const line = endLine();
          return [...line, { kind: 'report', ref: d.id, args: { outcome: readBack(), answered: true, record: null } }];
        }
        case 'error':
          return [{ kind: 'error', error: ev.error }];
        default:
          return [];
      }
    },
    flush: endLine,
  };
}

export function wireFor(model: string): VoiceWire {
  return voiceKind(model) === 'live' ? liveWire() : realtimeWire();
}
```

```ts
// apps/brain/src/calls/bridge.ts
// The live call: Twilio's media socket on one side, the voice model on the other. μ-law audio passes through
// untouched both ways. Go's own lines become the card's transcript; the model's report ends the call politely;
// the cap ends it regardless. Nothing here transcribes the business or keeps their words (Keshav's ruling).
import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';
import type { Schedule } from '../proactive/clock.js';
import { ReportedOutcome, type CallBrief, type SessionSettings } from './realtime.js';
import type { CallLine } from './store.js';
import { wireFor, type VoiceEvent } from './voice-wire.js';

export type EndReason = 'hangup' | 'cap' | 'error';

export interface BridgeHooks {
  talking(callId: string): Promise<void>;
  /** Go's own lines only. */
  line(callId: string, line: CallLine): void;
  outcome(callId: string, o: ReportedOutcome): void;
  ended(callId: string, reason: EndReason): Promise<void>;
}

export interface BridgeDeps {
  /** Checks the one-use token; null refuses the connection. */
  claim(callId: string, token: string): Promise<CallBrief | null>;
  openVoice(): WebSocket;
  hangUp(callId: string): Promise<void>;
  hooks: BridgeHooks;
  schedule: Schedule;
  capMs: number;
  /** The voice model (it picks the wire) and its voice. */
  session: SessionSettings;
  log: { warn(obj: object, msg: string): void };
}

export const GREET_AFTER_MS = 4_000;
export const WRAP_UP_BEFORE_MS = 20_000;
export const HANG_UP_AFTER_GOODBYE_MS = 2_500;
export const HANG_UP_AFTER_REPORT_MS = 15_000;
/** Barge-in without a speech event (gpt-live-1): this loud for this many 20 ms frames while Go's audio plays. Tuned on day one. */
export const BARGE_IN_LEVEL = 1_500;
export const BARGE_IN_FRAMES = 3;

const TwilioFrame = z.object({
  event: z.string(),
  start: z
    .object({ streamSid: z.string(), callSid: z.string().optional(), customParameters: z.record(z.string(), z.string()).optional() })
    .optional(),
  media: z.object({ payload: z.string(), timestamp: z.union([z.string(), z.number()]).optional() }).optional(),
  mark: z.object({ name: z.string() }).optional(),
});

/** One G.711 μ-law byte as a 16-bit sample. */
function linear(u: number): number {
  const x = ~u & 0xff;
  const magnitude = ((((x & 0x0f) << 3) + 0x84) << ((x >> 4) & 0x07)) - 0x84;
  return x & 0x80 ? -magnitude : magnitude;
}

/** How loud one Twilio frame is: the root mean square of its samples, 0 for silence. */
export function frameLevel(payload: string): number {
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) return 0;
  let sum = 0;
  for (const b of bytes) {
    const s = linear(b);
    sum += s * s;
  }
  return Math.sqrt(sum / bytes.length);
}

export function attachBridge(twilio: WebSocket, callId: string, d: BridgeDeps): void {
  const wire = wireFor(d.session.model);
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
  // Barge-in by loudness (an 'energy' wire): Go's audio chunks sent to Twilio and not yet played.
  const playing = new Set<string>();
  let marks = 0;
  let loudFrames = 0;
  let spokeAfterReport = false;
  let goodbye: (() => void) | null = null;
  const cancels: Array<() => void> = [];

  const toTwilio = (frame: object): void => {
    if (twilio.readyState === WebSocket.OPEN) twilio.send(JSON.stringify(frame));
  };
  const toModel = (event: object): void => {
    if (rt && rt.readyState === WebSocket.OPEN) rt.send(JSON.stringify(event));
  };
  const toModelAll = (events: object[]): void => {
    for (const event of events) toModel(event);
  };
  const cancelGoodbye = (): void => {
    goodbye?.();
    goodbye = null;
  };

  async function end(reason: EndReason): Promise<void> {
    if (ended) return;
    ended = true;
    for (const cancel of cancels) cancel();
    cancelGoodbye();
    if (started) {
      for (const e of wire.flush()) if (e.kind === 'go_line') d.hooks.line(callId, { who: 'go', text: e.text });
    }
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

  /** After the report, once Twilio has played every chunk of the goodbye, hang up shortly after (energy wires). */
  function afterPlayed(): void {
    if (!reported || !spokeAfterReport || playing.size > 0 || goodbye) return;
    goodbye = d.schedule(() => hangUp('hangup'), HANG_UP_AFTER_GOODBYE_MS);
  }

  /** No speech event (gpt-live-1): a short run of loud frames from the business while Go's audio still plays clears it. */
  function listen(payload: string): void {
    loudFrames = frameLevel(payload) >= BARGE_IN_LEVEL ? loudFrames + 1 : 0;
    if (loudFrames < BARGE_IN_FRAMES) return;
    loudFrames = 0;
    heardThem = true;
    if (playing.size === 0) return;
    playing.clear();
    toTwilio({ event: 'clear', streamSid });
  }

  function onVoice(e: VoiceEvent): void {
    switch (e.kind) {
      case 'audio': {
        if (e.itemId !== lastItem) {
          lastItem = e.itemId;
          responseStartTs = latestTs;
        }
        goSpoke = true;
        toTwilio({ event: 'media', streamSid, media: { payload: e.audio } });
        if (wire.bargeIn === 'energy') {
          marks += 1;
          const name = `go_${marks}`;
          playing.add(name);
          toTwilio({ event: 'mark', streamSid, mark: { name } });
          if (reported) {
            spokeAfterReport = true;
            cancelGoodbye();
          }
        }
        return;
      }
      case 'caller_started':
        heardThem = true;
        if (lastItem !== null && responseStartTs !== null) {
          toTwilio({ event: 'clear', streamSid });
          toModelAll(wire.truncate(lastItem, Math.max(0, latestTs - responseStartTs)));
        }
        lastItem = null;
        responseStartTs = null;
        return;
      case 'go_line':
        d.hooks.line(callId, { who: 'go', text: e.text });
        return;
      case 'report': {
        if (reported) {
          toModelAll(wire.answerReport(e.ref, true));
          return;
        }
        const parsed = ReportedOutcome.safeParse(e.args);
        toModelAll(wire.answerReport(e.ref, parsed.success));
        if (!parsed.success) return;
        reported = true;
        d.hooks.outcome(callId, parsed.data);
        cancels.push(d.schedule(() => hangUp('hangup'), HANG_UP_AFTER_REPORT_MS));
        return;
      }
      case 'response_started':
        if (reported && goodbyeId === null) goodbyeId = e.id;
        return;
      case 'response_done':
        if (goodbyeId !== null && e.id === goodbyeId) cancels.push(d.schedule(() => hangUp('hangup'), HANG_UP_AFTER_GOODBYE_MS));
        return;
      case 'error':
        d.log.warn({ callId, error: e.error }, 'calls: the voice model reported an error');
        return;
    }
  }

  function openModel(brief: CallBrief): void {
    const socket = d.openVoice();
    rt = socket;
    socket.on('open', () => toModel(wire.start(brief, d.session)));
    socket.on('message', (data: RawData) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      for (const e of wire.read(ev)) onVoice(e);
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
        if (!heardThem && !goSpoke) toModelAll(wire.speakFirst(brief));
      }, GREET_AFTER_MS));
      cancels.push(d.schedule(() => toModelAll(wire.wrapUp()), d.capMs - WRAP_UP_BEFORE_MS));
      cancels.push(d.schedule(() => hangUp('cap'), d.capMs));
      return;
    }
    if (!started) return;
    if (frame.event === 'media' && frame.media) {
      if (frame.media.timestamp !== undefined) latestTs = Number(frame.media.timestamp);
      toModel(wire.appendAudio(frame.media.payload));
      if (wire.bargeIn === 'energy') listen(frame.media.payload);
      return;
    }
    if (frame.event === 'mark' && frame.mark) {
      playing.delete(frame.mark.name);
      afterPlayed();
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
git add apps/brain/src/calls/realtime.ts apps/brain/src/calls/voice-wire.ts apps/brain/src/calls/bridge.ts apps/brain/src/calls/bridge.test.ts
git commit -m "feat(calls): the live call, Twilio's mu-law straight to the voice model and back, Go's own lines only, barge-in and a 4 minute cap

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `bridge.test.ts` passes (no transcriber on either model, audio both ways, barge-in by speech event and by marks and loudness, Go's lines only, outcome by report and by read-back, wrong token, cap, hang-ups); earlier tests stay green.

### Task 12: The call service and `call_business` (window, dial, live card, outcome, failures)

**Files:**
- Create: `apps/brain/src/calls/card-updater.ts`
- Create: `apps/brain/src/calls/service.ts`
- Create: `apps/brain/src/calls/tool.ts`
- Test: `apps/brain/src/calls/card-updater.test.ts`
- Test: `apps/brain/src/calls/service.test.ts`

**Interfaces:**
- Consumes: `TurnCtx.stableId` (P1, for the call id); `Schedule` (Task 1); `clip`, `plain` (Task 5); `CallsConfig`, `findCallee`, `loadCallsConfig`, `mediaUrl`, `statusUrl`, `maskPhone`, `CALL_WINDOW_MS`, `CARD_GAP_MS`, `RING_TIMEOUT_S`, `TWILIO_TIME_LIMIT_S` (Task 9); `saysStop` (Task 9); `CallStore`, `CallRow`, `CallLine` (Task 9); `TwilioClient`, `streamTwiml`, `twilioOutcome` (Task 10); `CallBrief`, `ReportedOutcome` (Task 11); `EndReason` (Task 11); `ServerLink` (P1); `Switches.get('CALLS_MODE')` (P1); `Packs.get`, `TripPack` (P1); `Message`, `CardTapParams`, `CardTapResult` (P1); `QuickTool`, `TurnCtx` (P1); `CallCard` (`@go/contract`).
- Produces:
  - `card-updater.ts`: `class CardUpdater<C> { constructor(send: (card: C) => Promise<void>, o: { now; schedule; minGapMs; log }); update(card: C): void; final(card: C): Promise<void> }`.
  - `service.ts`: `type CallCardIn = z.input<typeof CallCard>`; `STOP_LINE`; `ORPHAN_AFTER_MS = 15_000`; `NO_MEDIA_AFTER_MS = 90_000`; `CLOSE_OUT_AFTER_MS = 10_000`; `interface CallRequest { callId: string; business; phone?: string | undefined; goal; announce: string; factsAllowed: string[] }`; `type CallRequestResult`; `interface CallServiceDeps { store; link; packs; switches; config; twilio: TwilioClient | null; now; schedule; log }`; `forWhom(pack): string`; `class CallService` with `mode()`, `callable(): string[]`, `liveFor(tripId)`, `recentlyCancelled(tripId)`, `request(tripId, pack, r)`, `onMessage(msg, pack)`, `tick()`, `claim(callId, token)`, `talking(callId)`, `line(callId, line)`, `outcome(callId, o)`, `ended(callId, reason)`, `hangUp(callId)`, `stopTap(tap)`, `onTwilioStatus(callId, status)`, `fail(callId, why)`.
  - `tool.ts`: `CallBusinessArgs` (zod) and its type; `callTool(service: CallService): QuickTool<CallBusinessArgs>` (name `call_business`).

The room behaviour follows spec §14 and the guide's flow (`docs/guide/09-flows.md` §5) exactly:
1. `call_business` checks the switch (`CALLS_MODE` must read `allowlist`), the settings, the allowlist (by number, or by a listed name), refuses card, bank, OTP or login words and long digit runs in the goal or the facts, and refuses a second live call for the trip. Then it posts one line, the composer's own words plus "Say stop in the next 30 seconds if you'd rather I didn't.", and stores the call with `dial_at = now + 30 s`. The call card is posted when dialing starts, as the guide's flow does.
2. In the window, any person's message after Go's line that says stop (Task 9's words), or a bare "no"/"nahi" in reply to Go's line, cancels the call; Go replies "Okay, I won't call Villa Sol." The `calls` "right now" block (Task 13) tells the composer it already replied.
3. At 30 s the tick reads the switch again (flipped to `off` means "Calls are switched off right now, so I didn't call Villa Sol."), posts the call card (`dialing`, a "Stop the call" button), stores the token's hash and places the Twilio call.
4. While talking, the card is replaced at most every 3 s with Go's latest line (`last_line`, always `who: 'go'`); the final card (state `ended`, `outcome`, Go's lines as `transcript`, `ended_at`, no buttons) always lands. `line()` drops anything that is not Go's own line, so the business's words can never reach the card even if a voice model sent them (Keshav's ruling; showing them needs his explicit OK).
5. The end: the outcome as a reply to the person who asked; if the outcome settles something, `add_record_line` with `proof` = the call card's message (decision: P6 writes the line directly instead of going through P2's `record` tool, because the proof is Go's own card message, not a person's message, and the call ends outside any composer turn). An `open` line asks the organizer and names them.
6. Failures: busy, no answer, failed or a Twilio refusal turn the card to `failed` and say one line. The tick closes out a call left talking by a restart (after 15 s), a call that never got media (after 90 s), and any ended call whose close-out did not finish.

The call id comes from the turn: `ctx.stableId('call')` (for example `call_turn_01JB..._1`), so a rerun of the same turn finds its own call and posts nothing twice. Every later write happens outside a turn and uses `request_id = go_<call_id>_<step>` (`announce`, `cancel`, `off`, `card`, `outcome`, `record`, `fail`), the card id is `c_<call_id>`, and updates to the one call card stay sequential (`replace_card` has no request id), so a re-run after a crash repeats nothing.

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
import { CallService, STOP_LINE, type CallRequest } from './service.js';
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
const base = {
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
  let n = 0;
  /** As the tool does: a fresh call id per new request (the turn's stableId('call')). */
  const request = (over: Partial<CallRequest> = {}) => service.request(tripId, pack, { ...base, callId: `call_${tripId}_${++n}`, ...over });
  return { time, link, values, twilioCalls, hangUps, service, pack, request };
}

async function dialed(tripId: string) {
  const m = make(tripId);
  const r = await m.request();
  if (!('ok' in r)) throw new Error('refused');
  m.time.advance(30_000);
  await m.service.tick();
  const token = /name="token" value="([^"]+)"/.exec(m.twilioCalls[0]?.twiml ?? '')?.[1] ?? '';
  return { ...m, callId: r.callId, token };
}

describe('request', () => {
  it('refuses when calls are off', async () => {
    const m = make('t_off', { mode: 'off' });
    expect(await m.request()).toEqual({ refused: 'Calls are switched off right now.' });
    expect(m.link.calls).toHaveLength(0);
  });

  it('refuses a number or a business that is not on the allowlist', async () => {
    const m = make('t_list');
    expect(await m.request({ phone: '+919999999999' })).toHaveProperty('refused');
    expect(await m.request({ business: 'Casa Azul' })).toHaveProperty('refused');
    expect(m.link.calls).toHaveLength(0);
  });

  it('refuses card, bank and login details, so a call can never pay', async () => {
    const m = make('t_pay');
    expect(await m.request({ factsAllowed: ["Rahul's card 4111 1111 1111 1111"] })).toHaveProperty('refused');
    expect(await m.request({ goal: 'Pay the deposit by UPI' })).toHaveProperty('refused');
    expect(m.link.calls).toHaveLength(0);
  });

  it('says who and why with the stop line, waits 30 s, and allows one call at a time', async () => {
    const m = make('t_announce');
    const r = await m.request();
    expect(r).toEqual({ ok: true, callId: 'call_t_announce_1', dialAt: '2026-10-06T10:00:30.000Z' });
    const [announce] = m.link.of('post_message');
    expect(announce).toMatchObject({ request_id: 'go_call_t_announce_1_announce', trip_id: 't_announce', text: `I'll call Villa Sol about early check-in, 10 am on the 6th. ${STOP_LINE}` });
    expect(String(announce?.text)).not.toContain('—');
    expect(m.twilioCalls).toHaveLength(0);
    expect(await m.request()).toEqual({ refused: 'Go is already on a call for this trip. One at a time.' });
  });

  it('repeats nothing when a rerun of the same turn asks again with the same call id', async () => {
    const m = make('t_rerun');
    await m.request();
    const again = await m.service.request('t_rerun', m.pack, { ...base, callId: 'call_t_rerun_1' });
    expect(again).toMatchObject({ ok: true, callId: 'call_t_rerun_1' });
    expect(m.link.of('post_message')).toHaveLength(1);
  });
});

describe('the stop window', () => {
  it('a Hinglish stop cancels the call before it dials', async () => {
    const m = make('t_ruko');
    await m.request();
    await m.service.onMessage(msg({ id: 'm_stop', seq: 1002, by: 'p_priya', text: 'ruk jao, mat karo abhi' }), m.pack);
    expect(m.link.of('post_message').at(-1)).toMatchObject({ text: "Okay, I won't call Villa Sol.", reply_to: 'm_stop' });
    m.time.advance(30_000);
    await m.service.tick();
    expect(m.twilioCalls).toHaveLength(0);
  });

  it('takes a bare "nahi" only as a reply to the call line', async () => {
    const m = make('t_nahi');
    await m.request();
    await m.service.onMessage(msg({ seq: 1002, by: 'p_kabir', text: 'nahi' }), m.pack);
    expect((await m.service.liveFor('t_nahi'))?.state).toBe('waiting');
    await m.service.onMessage(msg({ seq: 1003, by: 'p_kabir', text: 'nahi', replyTo: 'm_go_1' }), m.pack);
    expect(await m.service.liveFor('t_nahi')).toBeNull();
  });

  it('a stop said before Go spoke does not count', async () => {
    const m = make('t_before');
    await m.request();
    await m.service.onMessage(msg({ seq: 900, by: 'p_priya', text: 'stop' }), m.pack);
    expect((await m.service.liveFor('t_before'))?.state).toBe('waiting');
  });

  it('switching calls off inside the window means no call', async () => {
    const m = make('t_flip');
    await m.request();
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
    expect(card).toMatchObject({ request_id: `go_${m.callId}_card`, card: { card_id: `c_${m.callId}`, kind: 'call', call_id: m.callId, business: 'Villa Sol', state: 'dialing', actions: [{ action_id: 'stop', label: 'Stop the call', style: 'secondary' }] } });
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
    await m.request();
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
    m.service.line(m.callId, { who: 'go', text: 'So, 10 am check-in is fine — and ₹2,000 off for the deposit this week.' });
    // The card carries Go's side only (Keshav's ruling): a line from the business is dropped.
    m.service.line(m.callId, { who: 'them', text: 'Yes, that is right.' });
    await flush();
    expect(m.link.of('replace_card')).toHaveLength(1);
    m.time.advance(3000);
    await flush();
    expect(m.link.of('replace_card')).toHaveLength(2);
    expect(m.link.of('replace_card').at(-1)).toMatchObject({ card: { state: 'talking', last_line: { who: 'go', text: 'So, 10 am check-in is fine, and ₹2,000 off for the deposit this week.' } } });

    m.service.outcome(m.callId, { outcome: '10 am check-in is fine. They offered ₹2,000 off if we pay the deposit this week.', answered: true, record: { kind: 'open', text: '₹2,000 off at Villa Sol if we pay the deposit this week?' } });
    await m.service.ended(m.callId, 'hangup');

    const final = m.link.of('replace_card').at(-1)?.card as Record<string, unknown>;
    expect(final).toMatchObject({ state: 'ended', outcome: '10 am check-in is fine. They offered ₹2,000 off if we pay the deposit this week.' });
    expect((final.transcript as Array<{ who: string }>).map((l) => l.who)).toEqual(['go', 'go']);
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
import { createHash, randomBytes } from 'node:crypto';
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

export interface CallRequest {
  /** From the turn's ctx.stableId('call'): a rerun of the same turn finds its own call and repeats nothing. */
  callId: string;
  business: string;
  phone?: string | undefined;
  goal: string;
  announce: string;
  factsAllowed: string[];
}
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
    let row = await this.d.store.get(r.callId);
    if (row && row.tripId !== tripId) return { refused: 'That call belongs to another trip.' };
    if (!row) {
      if (this.mode() === 'off') return { refused: 'Calls are switched off right now.' };
      if (!this.d.twilio || this.d.config.missing.length > 0) return { refused: 'Calls are not set up yet.' };
      if ([r.goal, ...r.factsAllowed].some((t) => NOT_ON_A_CALL.test(t) || LONG_DIGITS.test(t))) {
        return { refused: 'Calls never pay or share card, bank, OTP or login details. Leave those out.' };
      }
      const callee = findCallee(this.d.config, { business: r.business, phone: r.phone });
      if (!callee) return { refused: `${r.business} is not on the list of numbers Go may call this week.` };
      if (await this.d.store.liveFor(tripId)) return { refused: 'Go is already on a call for this trip. One at a time.' };
      let asker: Message | null = null;
      for (const m of pack.messages) if (m.author.kind === 'person' && m.mentions_go && !m.deleted) asker = m;
      row = await this.d.store.create({
        callId: r.callId,
        tripId,
        business: clip(plain(r.business), 80),
        phone: callee.phone,
        goal: clip(plain(r.goal), 160),
        factsAllowed: r.factsAllowed.map((f) => clip(f, 200)),
        forWhom: forWhom(pack),
        askedByPersonId: asker && asker.author.kind === 'person' ? asker.author.person_id : null,
        askedMessageId: asker ? asker.message_id : null,
        cardId: `c_${r.callId}`,
        dialAt: new Date(this.d.now().getTime() + CALL_WINDOW_MS),
      });
    }
    if (row.state === 'waiting' && row.announceMessageId === null) {
      try {
        const posted = await this.d.link.request('post_message', {
          request_id: rid(row.callId, 'announce'),
          trip_id: tripId,
          text: clip(`${plain(r.announce)} ${STOP_LINE}`, 2000),
        });
        await this.d.store.announced(row.callId, posted.message_id, posted.seq);
      } catch (err) {
        await this.d.store.cancel(row.callId, 'announce_failed', this.d.now());
        throw err;
      }
      this.d.log.info({ callId: row.callId, tripId, to: maskPhone(row.phone) }, 'calls: announced; dialing in 30 s unless someone says stop');
      this.d.schedule(() => {
        this.tick().catch((err: unknown) => this.d.log.warn({ err }, 'calls: tick failed'));
      }, Math.max(0, row.dialAt.getTime() - this.d.now().getTime()));
    }
    return { ok: true, callId: row.callId, dialAt: row.dialAt.toISOString() };
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

  /** Go's own lines only: the card never shows the business's words (Keshav's ruling; showing them needs his explicit OK). */
  line(callId: string, line: CallLine): void {
    if (line.who !== 'go') return;
    const live = this.live.get(callId);
    if (!live) return;
    const l: CallLine = { who: 'go', text: clip(plain(line.text), 500) };
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
        callId: ctx.stableId('call'),
        business: args.business,
        phone: args.phone,
        goal: args.goal,
        announce: args.announce,
        factsAllowed: args.facts_allowed,
      });
      if ('refused' in r) return r;
      return { ok: true, call_id: r.callId, note: 'Posted the call line. Say nothing more about the call now: end the turn with no text.' };
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

### Task 13: Wiring calls into Go (routes, the media socket, the Stop button, "Go can phone")

**Files:**
- Create: `apps/brain/src/calls/register.ts`
- Modify: `apps/brain/src/main.ts` (add `registerCalls` to `LANES`, right after `registerProactive`)
- Test: `apps/brain/src/calls/register.test.ts`

**Interfaces:**
- Consumes: Tasks 9 to 12; `Brain`, `RegisterLane` (P1); `brain.http` (Fastify); `brain.door.onUpgrade(path: RegExp, handle: UpgradeHandler)` and `brain.onStop(fn)` (P1, master §6.3); `brain.tools.register`, `brain.hooks.onRead`, `brain.taps.on('call', 'stop', ...)`, `brain.context.addNow` (P1); `realSchedule`, `Schedule` (Task 1); `openVoice`, `REALTIME_VOICE`, `CallsConfig.voiceModel` (Tasks 9 and 11).
- Produces: `CALLS_ORDER = 70`; `MEDIA_PATH`; `callsNow(service: CallService): NowProvider` (name `calls`); `interface CallsHandles { service: CallService; tick(): Promise<void>; stop(): void }`; `interface StartCallsOpts { intervals?: boolean; fetch?: typeof fetch; openVoice?: () => WebSocket; schedule?: Schedule }`; `startCalls(brain, opts?): Promise<CallsHandles>` (logs one error line and throws at boot when the door has no `onUpgrade`, before anything is registered); `registerCalls: RegisterLane`.

What it adds to the service:
- `POST /calls/twilio/status/:callId`: Twilio's status callback, form-encoded, checked against `X-Twilio-Signature` for the URL Go built from `GO_PUBLIC_URL`; 403 when the signature is wrong, 204 otherwise.
- The media socket `GET /calls/media/:callId` (WebSocket upgrade), handed over by P1's door with `brain.door.onUpgrade(MEDIA_PATH, handler)` (master §6.3: checked before the `/v1/socket` rule, no signature check by the door; the bridge checks the call's one-use token itself) and served by a `noServer` `WebSocketServer`. There is no second listener on `brain.http.server`: if the door has no `onUpgrade`, `startCalls` logs one error line and throws at boot, so a missing hook is loud instead of hidden. The day-one check (Task 14) proves a real media connection gets through.
- The voice model is `CALLS_VOICE_MODEL` (Task 9; `gpt-realtime-2.1` when unset), passed to the bridge as `session.model`, which picks the wire (Task 11). Neither model is ever given input transcription.
- The `calls` "right now" block: the names Go may phone (never numbers), a call waiting or live for this trip, and a call someone just stopped (so the composer does not answer the "stop" a second time).
- A 1 s tick for the stop window and the sweeps, `unref()`ed and stopped through `brain.onStop` with the media handler (which then refuses new media sockets). A call still live when Go stops is closed out by the next start's sweep (Task 12).

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/src/calls/register.test.ts
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { withSchema } from '../db/test-db.js';
import { fakeBrain, goaPack, manualTime, msg, turnCtx, waitFor } from '../proactive/fakes.js';
import { startCalls } from './register.js';

const env = {
  GO_PUBLIC_URL: 'https://brain.test',
  TWILIO_ACCOUNT_SID: 'AC_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  TWILIO_FROM: '+14155550100',
  OPENAI_API_KEY: 'sk-test',
  CALLS_ALLOWLIST: 'Villa Sol=+919800000001',
};
const silence = Buffer.alloc(160, 0xff).toString('base64'); // one 20 ms frame of μ-law silence

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(async () => {
  await db.drop();
});

/** A scripted gpt-realtime-2.1: Go greets, then reports the outcome. It never sends a transcript of the business. */
function fakeModel() {
  const server = new WebSocketServer({ port: 0 });
  const got: Array<Record<string, any>> = [];
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const ev = JSON.parse(data.toString()) as { type: string; item?: { type?: string } };
      got.push(ev);
      if (ev.type === 'session.update') {
        ws.send(JSON.stringify({ type: 'response.output_audio_transcript.done', item_id: 'i1', transcript: 'Hi, this is Go, an AI assistant calling for a group of 5 friends travelling together.' }));
        ws.send(JSON.stringify({
          type: 'response.function_call_arguments.done', call_id: 'fc_1', name: 'report_outcome',
          arguments: JSON.stringify({ outcome: 'Check-in at 10 am on 6 Nov is fine.', answered: true, record: { kind: 'agreed', text: 'Villa Sol: check-in at 10 am on 6 Nov is fine' } }),
        }));
      }
      if (ev.type === 'conversation.item.create' && ev.item?.type === 'function_call_output') {
        ws.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_bye' } }));
        ws.send(JSON.stringify({ type: 'response.done', response: { id: 'resp_bye' } }));
      }
    });
  });
  return { server, got, url: () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('startCalls', () => {
  it('registers the tool, the stop hook, the Stop button, the media path with the door and the "Go can phone" block', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now, env, switches: { CALLS_MODE: 'allowlist' } });
    const h = await startCalls(brain, { intervals: false, schedule: time.schedule });
    expect(reg.tools.map((t) => t.name)).toEqual(['call_business']);
    expect(reg.onRead).toHaveLength(1);
    expect(reg.taps.has('call:stop')).toBe(true);
    expect(reg.upgrades).toHaveLength(1);
    expect(reg.upgrades[0]!.path.test('/calls/media/call_turn_1_1')).toBe(true);
    expect(reg.upgrades[0]!.path.test('/v1/socket')).toBe(false);
    expect(reg.stops).toHaveLength(1); // the tick stops when Go stops
    const block = await reg.nows.find((n) => n.name === 'calls')!.render('t_goa', []);
    expect(block).toContain('Go can phone (call_business with the name): Villa Sol.');
    expect(block).not.toContain('+91');
    h.stop();
  });

  it('refuses to start, loudly, when the door cannot hand it the media socket', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now, env, switches: { CALLS_MODE: 'allowlist' } });
    delete (brain.door as { onUpgrade?: unknown }).onUpgrade;
    await expect(startCalls(brain, { intervals: false, schedule: time.schedule })).rejects.toThrow(/onUpgrade/);
    expect(reg.tools).toEqual([]);
    expect(reg.taps.size).toBe(0);
  });

  it('runs a whole call: the line, the wait, the dial, the live card with Go\'s side, the outcome and the record', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const pack = goaPack({ messages: [msg({ id: 'm_300', seq: 300, by: 'p_arjun', text: '@Go ask the villa if we can check in at 10', mentionsGo: true })] });
    const { brain, app, reg, link } = fakeBrain({ pool: db.pool, now: time.now, env, switches: { CALLS_MODE: 'allowlist' }, pack });
    const model = fakeModel();
    const twilioReqs: Array<{ url: string; form: URLSearchParams }> = [];
    const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
      twilioReqs.push({ url: String(url), form: new URLSearchParams(String(init?.body ?? '')) });
      return new Response(JSON.stringify({ sid: 'CA_e2e', status: 'queued' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const h = await startCalls(brain, { intervals: false, fetch: fetchFake, openVoice: () => new WebSocket(model.url()), schedule: time.schedule });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    // 1. The composer calls the tool; Go says who and why.
    const tool = reg.tools.find((t) => t.name === 'call_business')!;
    const out = (await tool.run(
      tool.input.parse({ business: 'Villa Sol', goal: 'Ask if we can check in at 10 am on 6 Nov', announce: "I'll call Villa Sol about early check-in.", facts_allowed: ['Group of five', 'Staying 6 to 9 November'] }),
      turnCtx({ link, pack, wake: [] }),
    )) as { ok: boolean; call_id: string };
    expect(out.ok).toBe(true);
    const callId = out.call_id;
    expect(link.of('post_message')[0]?.text).toBe("I'll call Villa Sol about early check-in. Say stop in the next 30 seconds if you'd rather I didn't.");
    expect(await reg.nows.find((n) => n.name === 'calls')!.render('t_goa', [])).toContain('waiting 30 seconds');

    // 2. Nobody says stop: after 30 s Go dials.
    time.advance(30_000);
    await h.tick();
    expect(twilioReqs[0]?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls.json');
    const token = /name="token" value="([^"]+)"/.exec(twilioReqs[0]?.form.get('Twiml') ?? '')?.[1] ?? '';

    // 3. Twilio connects the media stream through the door; the voice model talks; the card goes live.
    const twilio = new WebSocket(`ws://127.0.0.1:${port}/calls/media/${callId}`);
    await new Promise((resolve) => twilio.once('open', resolve));
    twilio.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
    twilio.send(JSON.stringify({ event: 'start', streamSid: 'MZ_e2e', start: { streamSid: 'MZ_e2e', callSid: 'CA_e2e', customParameters: { token } } }));
    twilio.send(JSON.stringify({ event: 'media', streamSid: 'MZ_e2e', media: { timestamp: '0', payload: silence } }));
    await waitFor(() => link.of('replace_card').some((p) => (p.card as { state?: string }).state === 'talking'));
    // The default voice model, and no transcriber on it.
    await waitFor(() => model.got.some((e) => e.type === 'session.update'));
    const update = model.got.find((e) => e.type === 'session.update')!;
    expect(update.session.model).toBe('gpt-realtime-2.1');
    expect(JSON.stringify(update)).not.toMatch(/transcri/i);

    // 4. After report_outcome and the goodbye, Go hangs up through Twilio; Twilio closes the stream.
    await waitFor(() => {
      time.advance(500);
      return twilioReqs.some((r) => r.url.endsWith('/Calls/CA_e2e.json'));
    });
    expect(twilioReqs.find((r) => r.url.endsWith('/Calls/CA_e2e.json'))?.form.get('Status')).toBe('completed');
    twilio.close();

    // 5. The final card holds Go's side and the outcome; the outcome in the chat; the record line with the call card as proof.
    await waitFor(() => link.of('add_record_line').length === 1);
    const final = link.of('replace_card').at(-1)?.card as Record<string, unknown>;
    expect(final).toMatchObject({ call_id: callId, state: 'ended', outcome: 'Check-in at 10 am on 6 Nov is fine.' });
    expect(final.transcript).toEqual([{ who: 'go', text: 'Hi, this is Go, an AI assistant calling for a group of 5 friends travelling together.' }]);
    expect(link.of('post_message').at(-1)).toMatchObject({ text: 'Check-in at 10 am on 6 Nov is fine.', reply_to: 'm_300' });
    const cardPost = link.calls.findIndex((c) => c.method === 'post_message' && (c.params.card as { kind?: string } | undefined)?.kind === 'call');
    expect(cardPost).toBeGreaterThan(-1);
    expect(link.of('add_record_line')[0]).toMatchObject({ kind: 'agreed', text: 'Villa Sol: check-in at 10 am on 6 Nov is fine', person_ids: [] });

    // 6. Twilio's status callback is accepted only with Twilio's signature.
    const url = `https://brain.test/calls/twilio/status/${callId}`;
    const params = { AccountSid: 'AC_test', CallSid: 'CA_e2e', CallStatus: 'completed', CallDuration: '41' };
    const sig = createHmac('sha1', 'tok_test').update(Object.keys(params).sort().reduce((acc, k) => acc + k + params[k as keyof typeof params], url)).digest('base64');
    const post = (signature: string) => app.inject({
      method: 'POST',
      url: `/calls/twilio/status/${callId}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
      payload: new URLSearchParams(params).toString(),
    });
    expect((await post(sig)).statusCode).toBe(204);
    expect((await post('forged')).statusCode).toBe(403);

    h.stop();
    model.server.close();
    await app.close();
  });
});
```

- [ ] **Step 2: Push the test and see it fail**

Red is certain: the module does not exist yet. Go to Step 3.

- [ ] **Step 3: Write the implementation**

```ts
// apps/brain/src/calls/register.ts
// Wires calls into Go: the call_business tool, the stop words, the Stop button, the "Go can phone" block,
// Twilio's status callback and the media socket, which P1's door hands over.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { Brain, RegisterLane } from '../app.js';
import type { NowProvider } from '../composer/context.js';
import { realSchedule, type Schedule } from '../proactive/clock.js';
import { attachBridge } from './bridge.js';
import { CALL_CAP_MS, REALTIME_VOICE, loadCallsConfig, statusUrl } from './config.js';
import { openVoice } from './realtime.js';
import { CallService } from './service.js';
import { CallStore } from './store.js';
import { callTool } from './tool.js';
import { twilioClient, verifyTwilioSignature } from './twilio.js';

export const CALLS_ORDER = 70;
export const MEDIA_PATH = /^\/calls\/media\/(call_[A-Za-z0-9_-]{1,58})$/;

export function callsNow(service: CallService): NowProvider {
  return {
    name: 'calls',
    order: CALLS_ORDER,
    async render(tripId: string): Promise<string | null> {
      if (service.mode() === 'off') return null;
      const lines: string[] = [];
      const names = service.callable();
      if (names.length > 0) lines.push(`Go can phone (call_business with the name): ${names.join(', ')}.`);
      const live = await service.liveFor(tripId);
      if (live?.state === 'waiting') lines.push(`Go said it will call ${live.business} and is waiting 30 seconds for anyone to say stop.`);
      else if (live) lines.push(`Go is on a call to ${live.business} now (${live.state}). The call card shows it live.`);
      const stopped = await service.recentlyCancelled(tripId);
      if (stopped) lines.push(`The call to ${stopped.business} was called off because someone said stop, and Go already replied. Say nothing more about it.`);
      return lines.length > 0 ? lines.join('\n') : null;
    },
  };
}

export interface CallsHandles {
  service: CallService;
  tick(): Promise<void>;
  stop(): void;
}

export interface StartCallsOpts {
  /** Tests pass false and drive the tick by hand. */
  intervals?: boolean;
  fetch?: typeof fetch;
  openVoice?: () => WebSocket;
  schedule?: Schedule;
}

export async function startCalls(brain: Brain, o: StartCallsOpts = {}): Promise<CallsHandles> {
  // Twilio's media socket reaches Go only through the door (master §6.3: Door.onUpgrade). Without it every call
  // would ring and then sit in silence, so refuse to start, loudly, before anything is registered.
  if (typeof brain.door.onUpgrade !== 'function') {
    const why = 'calls: the door has no onUpgrade (master §6.3), so Twilio media cannot reach Go; calls not started';
    brain.log.error(why);
    throw new Error(why);
  }
  const config = loadCallsConfig(brain.env);
  const schedule = o.schedule ?? realSchedule;
  const twilio = config.accountSid && config.authToken
    ? twilioClient({ accountSid: config.accountSid, authToken: config.authToken, ...(o.fetch ? { fetch: o.fetch } : {}) })
    : null;
  const service = new CallService({
    store: new CallStore(brain.pool),
    link: brain.door.link,
    packs: brain.packs,
    switches: brain.switches,
    config,
    twilio,
    now: brain.now,
    schedule,
    log: brain.log,
  });

  brain.tools.register(callTool(service));
  brain.hooks.onRead((msg, _read, pack) => service.onMessage(msg, pack));
  brain.taps.on('call', 'stop', (tap) => service.stopTap(tap));
  brain.context.addNow(callsNow(service));

  await brain.http.register(async (scope) => {
    if (!scope.hasContentTypeParser('application/x-www-form-urlencoded')) {
      scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      });
    }
    scope.post<{ Params: { callId: string }; Body: Record<string, string> }>('/calls/twilio/status/:callId', async (req, reply) => {
      const params = req.body ?? {};
      const signed = config.publicUrl !== null
        && verifyTwilioSignature(config.authToken, statusUrl(config.publicUrl, req.params.callId), params, req.headers['x-twilio-signature']);
      if (!signed) return reply.code(403).send({ error: { code: 'bad_signature', message: 'not signed by Twilio' } });
      await service.onTwilioStatus(req.params.callId, params.CallStatus ?? '');
      return reply.code(204).send();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const openModel = o.openVoice ?? (() => openVoice({ model: config.voiceModel, apiKey: config.openaiKey ?? '' }));
  let stopped = false;
  const onMedia = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const callId = MEDIA_PATH.exec((req.url ?? '').split('?')[0] ?? '')?.[1];
    if (stopped || !callId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      attachBridge(ws, callId, {
        claim: (id, token) => service.claim(id, token),
        openVoice: openModel,
        hangUp: (id) => service.hangUp(id),
        hooks: {
          talking: (id) => service.talking(id),
          line: (id, line) => service.line(id, line),
          outcome: (id, oc) => service.outcome(id, oc),
          ended: (id, reason) => service.ended(id, reason),
        },
        schedule,
        capMs: CALL_CAP_MS,
        session: { model: config.voiceModel, voice: REALTIME_VOICE },
        log: brain.log,
      }),
    );
  };
  brain.door.onUpgrade(MEDIA_PATH, onMedia);

  const handles: NodeJS.Timeout[] = [];
  if (o.intervals !== false) {
    const h = setInterval(() => {
      service.tick().catch((err: unknown) => brain.log.warn({ err }, 'calls: tick failed'));
    }, 1000);
    h.unref();
    handles.push(h);
  }
  brain.log.info({ voiceModel: config.voiceModel, missing: config.missing }, config.missing.length > 0 ? 'calls: not set up yet; call_business will refuse' : 'calls: ready');

  const stop = (): void => {
    stopped = true;
    for (const h of handles.splice(0)) clearInterval(h);
    wss.close();
  };
  // When Go stops (master §6.3: Brain.onStop), the tick stops and no new media socket is taken.
  brain.onStop(stop);

  return { service, tick: () => service.tick(), stop };
}

export const registerCalls: RegisterLane = async (brain) => {
  await startCalls(brain);
};
```

Edit `apps/brain/src/main.ts`: add the import below with the other lane imports, then insert `registerCalls` into the `LANES` array right after `registerProactive` (before `registerAdmin` when it is there):
```ts
import { registerCalls } from './calls/register.js';
```

- [ ] **Step 4: Commit, push, read CI**

```bash
git add apps/brain/src/calls/register.ts apps/brain/src/main.ts apps/brain/src/calls/register.test.ts
git commit -m "feat(calls): wire calls into Go, the status callback, the media socket through the door, the Stop button and who Go can phone

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `register.test.ts` passes (the whole call end to end against a fake Twilio and a scripted voice model, through the door's upgrade hook, with Go's side only on the card; and a loud refusal without `onUpgrade`); every earlier test stays green.

### Task 14: Gate G5: the 3:40 beat through the simulator, the day-one check, the first real call

**Files:**
- Create: `apps/brain/src/__tests__/e2e/proactive.e2e.test.ts`
- Create: `apps/brain/scripts/calls-day-one.mjs`

**Interfaces:**
- Consumes: P1's end-to-end pieces (`buildBrain`, `Built`, `loadEnv`, `registerRoom`, `withSchema`, `fakeAnthropic`, `Reply`, and from `__tests__/e2e/harness.ts`: `SECRET`, `TEST_TIMINGS`, `rightNow`, `afterTools`); P0's `@go/sim` (`FakeServer` with `new FakeServer({ goUrl, secret, instance })`, `start()`, `stop()`, `createTrip(snapshot)`, `writes: WriteRecord[]`, `waitFor(check, timeoutMs?)`; `goaFreshTrip()`); `startProactive` (Task 8).
- Produces: the G5 evidence: a CI run of the proactive beat through the real composer, a green day-one report, and the first real call.

This task waits for P1 Task 16 (the end-to-end harness) and P0 Task 9 (the FakeServer) to be on `build`; everything before it is green without them.

- [ ] **Step 1: Write the end-to-end test (the 3:40 beat through the real composer)**

```ts
// apps/brain/src/__tests__/e2e/proactive.e2e.test.ts
// G5, the 3:40 demo beat: a labelled simulated watch fires; the bar lets one pin through; the real composer
// (with a scripted model) posts one notice pinned to Arjun, labelled "Simulated for the demo".
import { FakeServer, goaFreshTrip } from '@go/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBrain, type Built } from '../../app.js';
import { withSchema } from '../../db/test-db.js';
import { loadEnv } from '../../env.js';
import { startProactive } from '../../proactive/register.js';
import { registerRoom } from '../../room.js';
import { fakeAnthropic, type Reply } from '../fixtures/fake-anthropic.js';
import { SECRET, TEST_TIMINGS, afterTools, rightNow } from './harness.js';

const ADMIN = 'admin-token-for-the-e2e-test';

function script(body: any): Reply {
  if (rightNow(body).includes('Simulated for the demo') && !afterTools(body)) {
    return {
      tools: [{
        name: 'post_notice',
        input: { tone: 'heads_up', title: 'Your flight is 2 hours late', body: 'You now land at 10:45 pm but your cab is at 9. Want me to move it to 11?', for_person_ids: ['p_arjun'] },
      }],
    };
  }
  return { tools: [{ name: 'stay_silent', input: { reason: 'nothing to add' } }] };
}

const isNotice = (w: { method: string; params: unknown }): boolean =>
  w.method === 'post_message' && (w.params as { card?: { kind?: string } }).card?.kind === 'notice';

let db: Awaited<ReturnType<typeof withSchema>>;
let built: Built;
let server: FakeServer;
let port = 0;
const trip = goaFreshTrip();

beforeAll(async () => {
  db = await withSchema();
  const env = loadEnv({
    PORT: '0', DATABASE_URL: process.env.DATABASE_URL, GO_SIGNING_SECRET: SECRET, GO_PUBLIC_URL: 'http://127.0.0.1',
    ANTHROPIC_API_KEY: 'test-key', LOG_LEVEL: 'silent', ADMIN_TOKEN: ADMIN,
  });
  built = await buildBrain(env, { pool: db.pool, anthropic: fakeAnthropic(script).client, logger: false, timings: TEST_TIMINGS });
  await registerRoom(built.brain);
  await startProactive(built.brain, { intervals: false, travel: null });
  ({ port } = await built.start());
  server = new FakeServer({ goUrl: `http://127.0.0.1:${port}`, secret: SECRET, instance: 'sim-p6' });
  await server.start();
  await server.createTrip(trip);
}, 30_000);

afterAll(async () => {
  server.stop();
  await built.stop();
  await db.drop();
});

async function fire(extra: Record<string, unknown> = {}): Promise<Response> {
  const body = JSON.stringify({
    trip_id: trip.trip_id, label: 'IndiGo 6E 2134', person_ids: ['p_arjun'], delay_minutes: 120,
    arrive_at: '2026-11-06T22:45:00+05:30', note: "Arjun's airport cab is booked for 9 pm", ...extra,
  });
  // Setup writes the trip row just after trip.created is answered; try for a few seconds.
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/admin/watch/fire`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body,
    });
    if (res.status !== 404) return res;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the trip never appeared');
}

describe('G5: Go speaks first', () => {
  it('3:40: the simulated delay reaches Arjun as one pinned, labelled notice', async () => {
    const res = await fire();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, promoted: 1 });
    const write = await server.waitFor(() => server.writes.find(isNotice), 10_000);
    expect((write.params as { card: unknown }).card).toMatchObject({
      kind: 'notice', for_person_ids: ['p_arjun'], source: { name: 'Simulated for the demo' },
    });
  });

  it('a double click posts once, and another nudge waits while nobody has spoken (never two in a row)', async () => {
    expect(await (await fire()).json()).toMatchObject({ duplicate: true, promoted: 0 });
    expect(await (await fire({ delay_minutes: 150 })).json()).toMatchObject({ promoted: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(server.writes.filter(isNotice)).toHaveLength(1);
  });

  it('the stage fire (force: true) gets past "two in a row", and two clicks at once post one labelled notice for Arjun', async () => {
    const [a, b] = await Promise.all([fire({ delay_minutes: 180, force: true }), fire({ delay_minutes: 180, force: true })]);
    const answers = [await a.json(), await b.json()] as Array<{ promoted: number; duplicate?: boolean }>;
    expect(answers.filter((x) => x.promoted === 1)).toHaveLength(1);
    expect(answers.filter((x) => x.duplicate === true)).toHaveLength(1);
    const second = await server.waitFor(() => server.writes.filter(isNotice)[1], 10_000);
    expect((second.params as { card: unknown }).card).toMatchObject({
      kind: 'notice', for_person_ids: ['p_arjun'], source: { name: 'Simulated for the demo' },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(server.writes.filter(isNotice)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Write the day-one check**

```js
#!/usr/bin/env node
// apps/brain/scripts/calls-day-one.mjs
// Day-one check for Go's phone calls. It never places a call. Run it from apps/brain with the brain
// service's environment, giving the teammate's number that will play the villa:
//   railway run --service brain node scripts/calls-day-one.mjs +919800000001
// It checks the Twilio account and caller number, that India is open for outbound calls, that a trial
// account has the number verified, the allowlist and the switch, that Go's media socket is reachable
// from outside, and that both voice models accept a mu-law session with no input transcription (the one
// CALLS_VOICE_MODEL picks must pass; the other is the day-one A/B and only warns). Exit code 1 if anything fails.
import WebSocket from 'ws';

// Keep these the same as apps/brain/src/calls/config.ts.
const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const LIVE_URL = 'wss://api.openai.com/v1/live';
const REALTIME_MODEL = 'gpt-realtime-2.1';
const LIVE_MODEL = 'gpt-live-1';
const VOICE = 'marin';

const env = process.env;
const target = (process.argv[2] ?? '').replace(/[\s\-().]/g, '');
const chosen = env.CALLS_VOICE_MODEL?.trim() || REALTIME_MODEL;
const results = [];
const pass = (name, detail) => results.push({ ok: true, name, detail });
const fail = (name, detail, fix) => results.push({ ok: false, name, detail, fix });
/** Only for the A/B: reported, never fails the run. */
const warn = (name, detail, fix) => results.push({ ok: true, warn: true, name, detail, fix });

async function twilioGet(url) {
  const auth = `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`;
  const res = await fetch(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function checkTwilio() {
  const sid = env.TWILIO_ACCOUNT_SID;
  if (!sid || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
    fail('Twilio settings', 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or TWILIO_FROM is missing', 'Set all three on the brain service in Railway.');
    return;
  }
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  const account = await twilioGet(`${base}.json`);
  if (account.status !== 200) {
    fail('Twilio account', `HTTP ${account.status}`, 'Check the account SID and auth token.');
    return;
  }
  const trial = account.body.type === 'Trial';
  pass('Twilio account', `${account.body.friendly_name} (${account.body.type}, ${account.body.status})`);

  const numbers = await twilioGet(`${base}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(env.TWILIO_FROM)}`);
  const number = numbers.body.incoming_phone_numbers?.[0];
  if (!number) fail('Caller number', `${env.TWILIO_FROM} is not a number on this account`, 'Buy a voice number, or set TWILIO_FROM to one this account owns.');
  else if (!number.capabilities?.voice) fail('Caller number', `${env.TWILIO_FROM} cannot make voice calls`, 'Pick a number with voice capability.');
  else pass('Caller number', `${env.TWILIO_FROM} can make voice calls`);

  const geo = await twilioGet('https://voice.twilio.com/v1/DialingPermissions/Countries/IN');
  if (geo.status !== 200) fail('India dialing', `could not read the geo permission (HTTP ${geo.status})`, 'Check Console > Voice > Settings > Geo permissions > India by hand.');
  else if (!geo.body.low_risk_numbers_enabled) fail('India dialing', 'India is not enabled for outbound calls', 'Enable India in Console > Voice > Settings > Geo permissions.');
  else pass('India dialing', 'enabled');

  if (trial && target) {
    const ids = await twilioGet(`${base}/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(target)}`);
    if ((ids.body.outgoing_caller_ids ?? []).length === 0) {
      fail('Trial account', `${target} is not verified`, "A trial account calls only verified numbers: verify the teammate's phone in the Console, or upgrade the account.");
    } else pass('Trial account', `${target} is verified`);
  }
}

function checkSettings() {
  const entries = (env.CALLS_ALLOWLIST ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  const numbers = entries.map((e) => e.slice(e.lastIndexOf('=') + 1).replace(/[\s\-().]/g, ''));
  if (entries.length === 0) fail('Allowlist', 'CALLS_ALLOWLIST is empty', 'Set it, e.g. "Villa Sol=+919800000001".');
  else if (target && !numbers.includes(target)) fail('Allowlist', `${target} is not on CALLS_ALLOWLIST`, 'Add it as "Villa Sol=<number>".');
  else pass('Allowlist', `${entries.length} entries`);
  if ((env.CALLS_MODE ?? 'off') !== 'allowlist') fail('CALLS_MODE', `is "${env.CALLS_MODE ?? 'off'}" in the environment`, 'Set CALLS_MODE=allowlist, or flip the switch on the admin page.');
  else pass('CALLS_MODE', 'allowlist');
  if (!env.OPENAI_API_KEY) fail('OPENAI_API_KEY', 'missing', 'Set it on the brain service in Railway.');
  if (!/^gpt-(realtime|live)/.test(chosen) || /transcri/i.test(chosen)) {
    fail('CALLS_VOICE_MODEL', `is "${chosen}"`, 'Leave it unset (gpt-realtime-2.1) or set gpt-live-1 for the A/B. Never a transcription model.');
  } else pass('CALLS_VOICE_MODEL', env.CALLS_VOICE_MODEL ? chosen : `${chosen} (unset, the default)`);
}

function checkMediaSocket() {
  return new Promise((resolve) => {
    if (!env.GO_PUBLIC_URL?.startsWith('https://')) {
      fail('Media socket', 'GO_PUBLIC_URL is not an https URL', "Set GO_PUBLIC_URL to the brain service's public https URL.");
      resolve();
      return;
    }
    const url = `wss://${new URL(env.GO_PUBLIC_URL).host}/calls/media/call_dayone_check`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      fail('Media socket', 'no answer in 10 s', 'Check the brain service is up and reachable.');
      ws.terminate();
      resolve();
    }, 10_000);
    ws.on('open', () => ws.send(JSON.stringify({ event: 'start', streamSid: 'MZ_check', start: { streamSid: 'MZ_check', customParameters: { token: 'not-a-real-token' } } })));
    ws.on('close', (code) => {
      clearTimeout(timer);
      if (code === 1008) pass('Media socket', 'reachable, and a wrong token is refused');
      else fail('Media socket', `closed with ${code}`, 'Expected 1008 for a wrong token.');
      resolve();
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      fail('Media socket', `upgrade answered HTTP ${res.statusCode}`, "The door refuses the media path: check that registerCalls ran (it registers through Door.onUpgrade, master §6.3) and the service logged no 'calls: the door has no onUpgrade' error.");
      resolve();
    });
    ws.on('error', () => undefined);
  });
}

/** Opens one voice model the way the bridge does (Task 11), with no input transcription, and reads its answer.
 *  The model CALLS_VOICE_MODEL picks must pass; the other one is the day-one A/B and only warns. */
function checkVoice(model, required) {
  const name = `Voice model ${model}${required ? '' : ' (A/B)'}`;
  const bad = (detail, fix) => (required ? fail : warn)(name, detail, fix);
  const live = model.startsWith('gpt-live');
  return new Promise((resolve) => {
    if (!env.OPENAI_API_KEY) {
      resolve();
      return;
    }
    const headers = { Authorization: `Bearer ${env.OPENAI_API_KEY}` };
    const ws = live ? new WebSocket(LIVE_URL, { headers }) : new WebSocket(`${REALTIME_URL}?model=${model}`, { headers });
    const done = () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    };
    const timer = setTimeout(() => {
      bad('no session in 10 s', 'Check the key and the network.');
      done();
    }, 10_000);
    ws.on('open', () =>
      ws.send(JSON.stringify(live
        ? {
            type: 'session.start',
            session: {
              model, instructions: 'Day-one check. Say nothing.', delegation: { type: 'client' }, store: false,
              audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: VOICE } },
            },
          }
        : {
            type: 'session.update',
            session: {
              type: 'realtime', model, output_modalities: ['audio'],
              audio: {
                input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } },
                output: { format: { type: 'audio/pcmu' }, voice: VOICE },
              },
            },
          })),
    );
    ws.on('message', (data) => {
      const ev = JSON.parse(String(data));
      if (!live && ev.type === 'session.updated') {
        const out = ev.session?.audio?.output?.format?.type;
        if (ev.session?.audio?.input?.transcription) {
          bad('input transcription is on', "Go hears with the voice model's own ears only (Keshav's ruling): the session must carry no audio.input.transcription.");
        } else if (out !== 'audio/pcmu') {
          bad(`session output format is ${out}`, 'The model did not take audio/pcmu: check the model id and the realtime docs.');
        } else pass(name, 'mu-law in and out, no input transcription');
        done();
      } else if (live && ev.type === 'session.started') {
        const format = ev.session?.audio?.format?.type;
        if (format && format !== 'audio/pcmu') bad(`session audio format is ${format}`, 'Live did not take audio/pcmu over this socket: keep gpt-realtime-2.1.');
        else pass(name, `a Live session started over ${LIVE_URL}${format ? ', mu-law' : ''}`);
        done();
      } else if (ev.type === 'error') {
        bad(ev.error?.message ?? 'error', live
          ? 'Check LIVE_URL and the session.start shape against the SDK (openai 7.15, resources/live/ws); fix them in calls/config.ts and calls/voice-wire.ts.'
          : `Check that ${model} exists for this key; change REALTIME_MODEL in calls/config.ts if not.`);
        done();
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      bad(`HTTP ${res.statusCode}`, live ? `Check LIVE_URL (${LIVE_URL}): Bash runs Live over WebRTC, so this socket address is unproven.` : 'Check the key and the model id.');
      done();
    });
    ws.on('error', () => undefined);
  });
}

await checkTwilio();
checkSettings();
await checkMediaSocket();
await checkVoice(chosen, true);
await checkVoice(chosen.startsWith('gpt-live') ? REALTIME_MODEL : LIVE_MODEL, false);

for (const r of results) {
  const word = r.warn ? 'WARN' : r.ok ? 'PASS' : 'FAIL';
  console.log(`${word}  ${r.name}: ${r.detail}${r.ok && !r.warn ? '' : `\n      fix: ${r.fix}`}`);
}
const twilioIndiaFailed = results.some((r) => !r.ok && (r.name === 'India dialing' || r.name === 'Caller number' || r.name === 'Twilio account'));
if (twilioIndiaFailed) {
  console.log('\nIf Twilio cannot call Indian numbers from this account, the fallback order is:');
  console.log('  1. Exotel or Plivo India (an Indian caller id; a second TwilioClient-shaped client in calls/, the bridge stays).');
  console.log("  2. OpenAI's own phone line (SIP), if the org has it: the call is accepted on OpenAI's side and Go drives it from a sideband socket.");
  console.log('  3. Vapi (about an hour to set up), driven by its API.');
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
```

- [ ] **Step 3: Commit, push, read CI**

```bash
git add apps/brain/src/__tests__/e2e/proactive.e2e.test.ts apps/brain/scripts/calls-day-one.mjs
git commit -m "test(proactive): the 3:40 beat through the simulator, and a day-one check for calls

Authored-By: Keshav Musunuri <keshav.led@gmail.com>"
git push && gh run watch --exit-status || gh run view --log-failed
```
Expected: `proactive.e2e.test.ts` passes in CI (one notice, pinned to Arjun, labelled; a double click posts nothing more; another unforced fire waits; the forced stage fire posts exactly one more notice, labelled and pinned to Arjun). The script is not run in CI.

- [ ] **Step 4: Day one (Wednesday, once Keshav has the Twilio account and the OpenAI key)**

1. Keshav sets on the `brain` service in Railway: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `OPENAI_API_KEY`, `CALLS_ALLOWLIST="Villa Sol=+91<teammate's number>"`, `CALLS_MODE=allowlist` (or the admin switch). `CALLS_VOICE_MODEL` stays unset (`gpt-realtime-2.1`).
2. Run `railway run --service brain node scripts/calls-day-one.mjs +91<teammate's number>` from `apps/brain`. Every line must say PASS. A FAIL prints the fix. The `gpt-live-1 (A/B)` line may say WARN; it only decides whether step 5.9 runs.
3. In OpenAI's platform settings, look for the phone line (SIP) option for the org and write down whether it is there; it is fallback 2 and removes the media bridge if Twilio's audio is poor.
4. If Twilio cannot call India from the account, stop here and pick the fallback in the order the script prints (Exotel or Plivo India; then OpenAI's phone line; then Vapi). Only `calls/twilio.ts` and `calls/register.ts` change for fallback 1; `service.ts`, the card and the room behaviour stay.

- [ ] **Step 5: The first real call (G5)**

In the dev room (or the App) on the Goa trip, with the teammate holding the allowlisted phone on speaker and playing the villa:
1. Arjun types: "@Go ask Villa Sol if we can check in at 10 am on the 6th". Expected: Go's line ending "Say stop in the next 30 seconds if you'd rather I didn't." within about 2 s.
2. Nobody says stop. At 30 s the call card appears ("Calling Villa Sol..."), and the teammate's phone rings.
3. The teammate answers "Villa Sol, hello?". Expected: "Hi, this is Go, an AI assistant calling for a group of 5 friends travelling together", then the question. The card turns to talking and shows Go's latest line, updating every few seconds; the room hears the villa on the speaker.
4. The teammate interrupts Go once mid-sentence. Expected: Go stops talking at once (barge-in).
5. The teammate says "Yes, 10 am is fine." Expected: Go thanks them and hangs up; the card shows the outcome and Go's side of the call (never the villa's words); Go replies to Arjun with the outcome; a record line appears with the call card as its proof.
6. Run it again and type "ruko" inside the 30 s: no ring, and Go says "Okay, I won't call Villa Sol."
7. Run it a third time and let it ring out: the card says it could not get through, and Go says "Villa Sol didn't pick up. Want me to try again later?"
8. Write down: time from Go's line to the ring, from "hello" to Go's first word, how barge-in felt, and anything that sounded wrong. Keep the card (Go's side and the outcome). This is the G5 evidence for calls; the stage call (1:00) is rehearsed by P7 with the same teammate.
9. The A/B, only if step 4.2's Live line passed: set `CALLS_VOICE_MODEL=gpt-live-1` on the service (it restarts, so do it between calls), run 1 to 5 once more, and write down the same numbers, plus how barge-in felt (Twilio marks and loudness instead of the model's speech event; raise `BARGE_IN_LEVEL` if the speakerphone's echo of Go trips it) and whether Go's "So, ..." read-back made a clean outcome. On `gpt-live-1` the call writes no record line. Set it back afterwards; which model the stage uses is Keshav's call.
10. On both models the card never shows the villa's words. Showing them needs Keshav's explicit OK (and would only be possible on `gpt-live-1`, whose input transcript is the model's own).

---

## Interface notes for the conductor

1. **`Door.onUpgrade`: settled in master §6.3 (P1 Task 5).** P1's door hands an upgrade whose path matches a lane's pattern to that lane before its `/v1/socket` rule, checks no signature for it, and refuses a pattern that would match `/v1/socket`. Task 13 registers `brain.door.onUpgrade(MEDIA_PATH, handler)` (`/^\/calls\/media\/(call_[A-Za-z0-9_-]{1,58})$/`, which never matches `/v1/socket`); the media token is checked by the bridge itself. The fallback that listened on `brain.http.server` is gone: if the door has no `onUpgrade`, `startCalls` logs one error line and throws at boot before anything is registered (Task 13 test). The day-one check (Task 14) still proves a real media connection gets through.

2. **Per-turn tool limits: settled in master §6.3 (P1 Tasks 10 to 13).** Task 8 registers `brain.context.addTurnRules(composerRules)`; `composerRules` (Task 5) returns P1's `TurnLimits` (`{ tools, mayPostText }`, the master's names, never `allowedTools`) or null for a turn a person, a tap or a task woke. P1 puts the answer on `TurnCtx.allowedTools` and `mayPostText`; its loop refuses any other tool except `stay_silent` (the definitions never change, so the 1 h cache holds) and drops the text when `mayPostText` is false, while `ctx.cards` still go. If P1 has no `addTurnRules`, `startProactive` logs one error line and throws at boot before anything is registered (Task 8 test). The wake text, the `openings` block and the notice tools stay: they tell the model the rules so it does not spend a round on a refused call, and keep pins to the right people.

3. **P4's status shapes: settled.** Watches use P4's `StatusQuery` and `StatusResult` (`travel/travel.ts`) as they are, with no adapter (`watches/port.ts` is gone): a watch stores the `StatusQuery` it sends (`{ kind: 'flight', carrierCode, number, date }` or `{ kind: 'pnr', pnr }`) and the last `StatusResult` it got, so a shape change is a compile error in `watches/`. Booked flights and booked train tickets (by PNR) are watched. Fares and rooms left are not, because P4's `StatusQuery` has no kind for them; bringing them back needs one more P4 kind, for example `{ kind: 'offer'; optionId }` answered with `{ kind: 'offer'; priceMinor; currency; available; left: number | null; checkedAt }`, plus a fare and a rooms-left case in `watches/diff.ts`. Such a watch would start from a vote option's `option_ref`, which is opaque (F24: an options card's `option_id`, never an offer id) and would be resolved with `await brain.travel.offer(option_ref)`; whether it is a stay would come from what the offer lookup or that status answer says, never from the shape of the id. P6 no longer reads `option_ref` anywhere, and its fixture uses `opt_villa_sol` and `opt_casa_azul`. The demo's "fire a watch" keeps its own simulated candidate rather than P4's `simulate.setFlightDelay` (Task 8 says why). The notice card carries no image, so P4's image cache (`travel/images.ts`) is not used.

4. **No desk gate is needed.** Timers, watch changes and openings wait in `proactive_candidates`; the promoter puts a desk item (`timer:<trip>:<key>`, `watch:<trip>:<key>`, `opening:<trip>:<key>`) only when the bar passes, so a refused nudge never costs a model turn.

5. **Ids for calls: settled.** The call id is the turn's `ctx.stableId('call')`; every later write is outside a turn and uses `go_<call_id>_<step>`; the card id is `c_<call_id>`. P1's turn ids are `turn_<ULID>` (31 characters), so `go_call_turn_<ULID>_<n>_announce` is about 50 characters, inside the contract's 64-character `Id`.

6. **The media token rides as a `<Parameter>`**, not `?token=` on the stream URL: Twilio's `<Stream url>` does not pass a query string to the socket. The path still names the call.

7. **The call card appears when dialing starts**, as `docs/guide/09-flows.md` §5 shows; during the 30 s window there is only Go's line, and a stop there is a message.

8. **`CALLS_ALLOWLIST` entries may carry a name: settled.** `Villa Sol=+919800000001` lets the composer call by name without seeing numbers; plain numbers still work. Task 9 takes over P1's `calls/env.ts` and says the `Name=` form in its comment and in `.env.example`.

9. **FakeServer names: settled (F1).** P1 now uses P0's `new FakeServer({ goUrl, secret, instance })` and `start()`, as P6 Task 14 does.

10. **The sweep finds active trips by `trips.created_at`** (last 90 days) and re-reads each with `read_trip` every 10 minutes; fine at hackweek scale.

11. **No second ear on calls (Keshav's ruling; F9).** Neither voice model is ever given input transcription, and nothing in `calls/` calls a speech-to-text service. The call card's `last_line` and `transcript`, and `calls.transcript`, carry Go's own lines only (`who: 'go'`, from the model's own output transcript); the `outcome` comes from the model's report; the room hears the business on the speaker. Three places enforce it: the session settings (Task 11; Task 14's day-one check fails if the account turns transcription on), the wires never emit the business's words (Task 11), and `CallService.line()` drops any line that is not Go's (Task 12). Showing the business's words needs Keshav's explicit OK, and would only be possible on `gpt-live-1`, whose input transcript is the model's own. Open for the conductor: the guide's call card example (`docs/guide/06-cards.md`, `last_line` and `transcript` with `who: 'them'` lines) and its call flow (`09-flows.md` §5, "the transcript") show the business's lines. The contract still allows them, so nothing breaks, but the docs describe a card Go will not send this week; a guide edit or a note is Keshav's call.

12. **`CALLS_VOICE_MODEL` (P6's one new variable).** In `calls/env.ts` (refused at boot unless it is a `gpt-realtime` or `gpt-live` model, never a transcriber) and in `apps/brain/.env.example`; master §6.7's P6 row could list it beside `CALLS_MODE`. Default `gpt-realtime-2.1`. `gpt-live-1` is the day-one A/B behind the same bridge: it has no speech-started event (barge-in uses Twilio `mark` events and an energy check on the business's audio), no function tools (Go says the outcome back as "So, ..." and hands off, so a Live call writes no record line), and two unconfirmed facts the day-one check proves first: the socket URL `LIVE_URL` (Bash runs Live over WebRTC with a sideband, never over a primary WebSocket) and `session.start` taking `audio/pcmu` at 8 kHz. Which model the stage uses belongs on Keshav's list (master §4).

13. **Lane timers stop with Go (master §6.3 `Brain.onStop`).** `startProactive` registers the stop of its three interval timers (promote 15 s, watch checks 30 s, sweep 10 min) and `startCalls` the stop of its 1 s tick and media handler, all through `brain.onStop`; every timer is also `unref()`ed (`realSchedule`'s one-shot timers already are). A call still live when Go stops is closed out by the next start's sweep (Task 12).

## Self-review

| Spec / master section | Where |
|---|---|
| §8 sources: the chat (Jev question 9) | Task 6 (`chatOpening`, the `onRead` hook) |
| §8 sources: trip changes (vote closed, booking cancelled, dates clash, payer waiting) | Task 6 (`tripChangeOpenings`), Task 3 (`payer_waiting`) |
| §8 sources: time (vote closing, free cancellation, travel day, settle-up) and §5 timers | Tasks 3 and 4 |
| §8 sources: the world and §12 status: a flight's delay or cancellation, a train ticket confirmed or cancelled, through P4's `Travel.status` as it is | Tasks 7 and 8; fares and rooms left wait for a P4 status kind (interface note 3) |
| §8 guardrail 1: the quietest useful action first | Task 1 (`decide`), Task 5 (wake text, `rulesForTurn`, `composerRules`, `post_notice` pins) |
| §8 guardrail 2: the bar, stricter at night in the trip's zone, never repeat a nudge | Task 1, Task 2 (`add` never re-adds a key), Task 4 |
| §8 guardrail 3: about 3 a day, never two in a row, small things batched | Task 1 (`DAILY_POSTS`, `lastWordIsGos`, `decideBatch`), Tasks 2 and 4 |
| §8 guardrail 4: suggest, never act | Task 5 (wake text, `openings` block, tools allowed exclude spending, tasks and calls), Task 8 (`addTurnRules`: P1 refuses any other tool and drops text that is not allowed) |
| §8 guardrail 5: pause, hush, ignored | Task 1, Task 5 (paused stripped), Task 6 (hush, ignored) |
| §14 calls: say who and why, 30 s for stop, then call | Tasks 9, 12, 13 |
| §14 calls: a live card updated in place; the outcome in the chat and the record; calls never pay | Tasks 11, 12, 13 |
| Keshav's ruling "no second ear" (F9): no transcriber; the card carries Go's side and the outcome | Task 9 (`isVoiceModel`, env refuses a transcriber), Task 11 (no `transcription` in either session; the business's words never reach `hooks.line`), Task 12 (`line()` keeps Go's lines only), Task 13 (end to end), Task 14 (the day-one check fails if transcription is on) |
| `CALLS_VOICE_MODEL` A/B: `gpt-realtime-2.1` by default, `gpt-live-1` behind the same bridge, barge-in by marks and loudness on Live | Task 9 (env, config, `.env.example`), Task 11 (`voice-wire.ts`, Live tests), Task 13 (`session.model`), Task 14 (both models checked; step 5.9) |
| Master §6.3 `Door.onUpgrade`, `Context.addTurnRules` / `TurnLimits`, `TurnCtx.allowedTools` / `mayPostText`, `Brain.onStop` | Task 13 and Task 8 (registered; boot fails loudly without the hooks; timers stopped through `onStop`), Task 5 (`composerRules`), Task 2 (`fakeBrain` mirrors all four) |
| P4's `StatusQuery` / `StatusResult` (F8) and opaque `option_ref` (F24) | Task 7 (stored and diffed as they are), Task 8 (runner sends the stored query; admin fire decision), Task 2 (fixture option ids), interface note 3 |
| Master §1 1:00 "the call" | Tasks 12, 13, 14 (first real call) |
| Master §1 3:40 "proactive and safe" | Tasks 8 and 14 |
| Master §7: allowlist only; no em dashes; never the vendor's name | Tasks 9 and 12; Task 5 (`plain`) and the call tests; Task 11 (instructions tests on both models) |
| Master §9: `CALLS_MODE` switch, admin "fire a watch" | Task 12 (read at request and again before dialing), Task 8 |
| Master §1 3:40 and §9: the stage fire with `force: true` (past the bar, the budget, "two in a row", hush and ignored raises, for that candidate only; still labelled, pinned to the named people, never to a paused person; a double click posts once) | Task 1 (`decideForced`, forced tests), Task 2 (`forced` column), Task 4 (payload carries it), Task 8 (`force`, `fireKey`, the forced stage-fire test), Task 14 (forced fire through the simulator) |
| research/hands.md §4: μ-law both ways, barge-in, no second speech-to-text, Twilio signature, day-one check, fallbacks | Tasks 10, 11, 14 |
| Gate G5 | Tasks 1 to 13 in CI, Task 14 (simulator run, day-one check, the real call) |

Review Focus lines and their tests: (1) wrong moment: Task 1 `decide` tests, Task 4 night and budget tests, Task 6 hush test; (2) repeats: Task 2 "never adds the same nudge twice", Task 3 replan test, Task 4 "no longer true", Task 7 "once per 15-minute step" and "once each" for a ticket, Task 8 runner "never twice"; (3) calls that must not happen: Task 9 `saysStop`, Task 12 request and stop-window tests; (4) the call card telling the truth and no more: Task 11 wrong token, cap, drop and "Go's lines only" tests on both models, Task 12 tap, no-answer, restart and "a line from the business is dropped" tests, Task 13 end to end, Task 14 day-one transcription check; (5) the simulated watch: Task 1 "lets the forced stage fire past ..." and "still never pings a paused person ... even when forced", Task 5 label tests, Task 8 demo-beat test (with the turn rules P1 gets and the double click) and "the stage fire (force: true) reaches the desk once ...", Task 14 simulator run (double click, forced fire).

Placeholder scan: no TBD, TODO or "similar to"; every code step is complete. Names consumed from master §6.3, P1 and P4 (`Brain`, `Brain.onStop`, `RegisterLane`, `Desk.put`, `Context.addNow`, `Context.addWake`, `Context.addTurnRules`, `TurnLimits`, `TurnCtx.allowedTools`, `TurnCtx.mayPostText`, `Door.onUpgrade`, `UpgradeHandler`, `MessageHooks.onRead`, `TripLog.onEvent`, `TapRouter.on`, `TurnCtx.cards`, `TurnCtx.stableId`, `Switches.get`, `Travel.status`, `StatusQuery`, `StatusResult`, `withSchema`, `LANES`, `CallsEnv`) match.
