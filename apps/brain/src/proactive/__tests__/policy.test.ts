import { describe, expect, it } from 'vitest';
import { addDays, isNight, localDay, localHour, nextMorning, tomorrowMorning, zonedTime } from '../clock.js';
import {
  AWAKE_REPLY_MS,
  BARS,
  DAILY_POSTS,
  HUSH_RAISE,
  NIGHT_RAISE,
  RECHECK_MS,
  SMALL_HOLD_MS,
  barRaise,
  decide,
  repliesToSomeoneAwake,
  decideBatch,
  score,
  type Candidate,
  type TripMood,
} from '../policy.js';

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

  it('lets a chime-in on a line written in the last 2 minutes speak at night: they are awake and talking; nothing else', () => {
    const fresh = chat({ facts: { message_id: 'm_9', seq: 9, said_at: new Date(LATE.getTime() - 30_000).toISOString() } });
    expect(decide(fresh, mood(), LATE)).toMatchObject({ kind: 'go', allowed: ['react', 'record', 'message'], counted: true });
    expect(repliesToSomeoneAwake(fresh, LATE)).toBe(true);
    // Said longer ago than AWAKE_REPLY_MS: the night raise holds.
    const stale = chat({ facts: { message_id: 'm_9', seq: 9, said_at: new Date(LATE.getTime() - AWAKE_REPLY_MS - 1).toISOString() } });
    expect(decide(stale, mood(), LATE)).toMatchObject({ kind: 'go', allowed: ['react', 'record'], counted: false });
    // What Go starts on its own keeps it, however fresh: a day timer still waits for 8 am.
    const timer = cand({ source: 'timer', topic: 'travel_day', importance: 0.6, urgency: 0.8, useful: ['message'], personIds: [], facts: { said_at: LATE.toISOString() } });
    expect(decide(timer, mood(), LATE)).toMatchObject({ kind: 'wait', reason: 'night' });
    // The rest of the bar still holds at night: never two in a row.
    const last = mood({ lastGoMessageAt: new Date(LATE.getTime() - 10_000), lastPersonMessageAt: new Date(LATE.getTime() - 60_000) });
    expect(decide(fresh, last, LATE)).toMatchObject({ kind: 'go', allowed: ['react', 'record'], counted: false });
  });

  it('holds a message that would pass by day until 8 am', () => {
    const c = cand({ topic: 'vote_closed', source: 'opening', importance: 0.7, urgency: 0.7, useful: ['message'], personIds: [] });
    expect(decide(c, mood(), NOON)).toMatchObject({ kind: 'go', allowed: ['message'] });
    expect(decide(c, mood(), LATE)).toEqual({ kind: 'wait', until: new Date('2026-10-07T02:30:00.000Z'), reason: 'night' });
  });

  it('drops a night nudge that expires before morning', () => {
    const c = cand({ importance: 0.7, urgency: 0.7, useful: ['message'], personIds: [], expiresAt: new Date(LATE.getTime() + 3600_000) });
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

  it('counts any message of Go\'s as its last word: an answer, then nobody, means no unprompted post yet', () => {
    const answered = mood({ lastGoMessageAt: new Date('2026-10-06T06:10:00Z'), lastPersonMessageAt: new Date('2026-10-06T06:00:00Z') });
    expect(decide(cand({ useful: ['pin'] }), answered, NOON)).toEqual({ kind: 'wait', until: new Date(NOON.getTime() + RECHECK_MS), reason: 'two_in_a_row' });
    const spoke = mood({ lastGoMessageAt: new Date('2026-10-06T06:10:00Z'), lastPersonMessageAt: new Date('2026-10-06T06:20:00Z') });
    expect(decide(cand({ useful: ['pin'] }), spoke, NOON)).toMatchObject({ kind: 'go', allowed: ['pin'] });
  });

  it('lets a hush lower how chatty Go is', () => {
    // One hush lifts the message bar from 0.3 to 0.45, which a chat opening (0.49) still clears; two (0.6) keep it quiet.
    const once = decide(chat(), mood({ hushCount: 1, lastHushAt: NOON }), NOON);
    expect(once).toMatchObject({ kind: 'go', allowed: ['react', 'record', 'message'], counted: true });
    expect((once as { bar: number }).bar).toBeCloseTo(0.45);
    const twice = mood({ hushCount: 2, lastHushAt: NOON });
    expect(decide(chat(), twice, NOON)).toMatchObject({ kind: 'go', allowed: ['react', 'record'], counted: false });
  });

  it('is proactive (Keshav, 2026-10-08): a message clears 0.3, eight posts a day, and the night and hush raises kept', () => {
    expect(BARS.message).toBe(0.3);
    expect(DAILY_POSTS).toBe(8);
    expect(NIGHT_RAISE).toBe(0.25);
    expect(HUSH_RAISE).toBe(0.15);
    // A day timer (0.48) posts by day, which the old 0.45 bar also let through, and still waits for 8 am at night.
    const day = cand({ source: 'timer', topic: 'travel_day', importance: 0.6, urgency: 0.8, useful: ['message'], personIds: [] });
    expect(decide(day, mood(), NOON)).toMatchObject({ kind: 'go', allowed: ['message'], counted: true });
    expect(decide(day, mood(), LATE)).toMatchObject({ kind: 'wait', reason: 'night' });
    // A nudge at 0.35 posts now; under 0.45 it was dropped.
    const plain = cand({ importance: 0.5, confidence: 1, urgency: 0.7, useful: ['message'], personIds: [] });
    expect(decide(plain, mood(), NOON)).toMatchObject({ kind: 'go', allowed: ['message'] });
    // The eighth post of the day goes; the ninth waits for tomorrow.
    expect(decide(day, mood({ postsToday: 7 }), NOON)).toMatchObject({ kind: 'go', allowed: ['message'] });
    expect(decide(day, mood({ postsToday: 8 }), NOON)).toEqual({ kind: 'wait', until: new Date('2026-10-07T02:30:00.000Z'), reason: 'budget' });
    // Never two in a row: after Go's own post with nobody since, even a proactive message waits for a person.
    const last = mood({ lastGoMessageAt: new Date('2026-10-06T06:10:00Z'), lastPersonMessageAt: new Date('2026-10-06T06:00:00Z') });
    expect(decide(chat(), last, NOON)).toMatchObject({ kind: 'go', allowed: ['react', 'record'], counted: false });
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

  it("lets what the group asked for (a watch on ixigo) past the spent budget and two in a row, but never past night or the bar", () => {
    const busy = mood({ postsToday: DAILY_POSTS, lastProactivePostAt: new Date('2026-10-06T06:10:00Z'), lastPersonMessageAt: new Date('2026-10-06T06:00:00Z') });
    const watch = cand({ asked: true, topic: 'recipe_watch', useful: ['message'], importance: 0.9, confidence: 0.9, urgency: 0.6, dedupeKey: 'recipe_watch:rw_1:fired' });
    expect(decide(watch, busy, NOON)).toMatchObject({ kind: 'go', allowed: ['message'], counted: true });
    // Not asked, the same nudge waits for tomorrow's budget.
    expect(decide({ ...watch, asked: false }, busy, NOON)).toMatchObject({ kind: 'wait', reason: 'budget' });
    // Night still holds it till morning, and a nudge below the bar never goes.
    expect(decide(watch, busy, LATE)).toMatchObject({ kind: 'wait', reason: 'night' });
    expect(decide({ ...watch, importance: 0.2 }, busy, NOON)).toEqual({ kind: 'drop', reason: 'below_bar' });
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
