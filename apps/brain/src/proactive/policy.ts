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
  /** Go's newest message of any kind in the chat (answers too), from the pack. */
  lastGoMessageAt?: Date | null;
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

/** True when nobody has spoken since Go last did: its last unprompted post, or any message of Go's in the chat. */
export function lastWordIsGos(m: TripMood): boolean {
  const go = Math.max(m.lastProactivePostAt?.getTime() ?? Number.NEGATIVE_INFINITY, m.lastGoMessageAt?.getTime() ?? Number.NEGATIVE_INFINITY);
  if (go === Number.NEGATIVE_INFINITY) return false;
  return m.lastPersonMessageAt === null || m.lastPersonMessageAt.getTime() <= go;
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
