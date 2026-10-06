// The try room's caps, so a visitor cannot run up a bill: messages that ask Go per UTC day across every visitor,
// everything sent into the room per UTC day, messages that ask Go in one visit, and new trips per UTC day. The counts
// live in memory, so a restart starts them again. Over a cap the room refuses and says so, and nothing reaches Go.
import { DAILY_LIMIT_LINE, sessionLimitLine } from './words.js';

export interface CapLimits {
  /** Messages that ask Go, per UTC day, across every visitor (TRY_DAILY_GO_ASKS). */
  dailyGoAsks: number;
  /** Everything people send into the room per UTC day: messages, taps, votes, reactions (TRY_DAILY_MESSAGES). */
  dailyMessages: number;
  /** Messages that ask Go in one visit (TRY_SESSION_GO_ASKS). */
  sessionGoAsks: number;
  /** New trips per UTC day: each visit's first trip and every "Start over" (TRY_DAILY_TRIPS). Each one wakes Go. */
  dailyTrips: number;
}

export const DEFAULT_CAPS: CapLimits = { dailyGoAsks: 150, dailyMessages: 600, sessionGoAsks: 25, dailyTrips: 100 };

/** A message asks Go when it has the word "go" in any case: wider than Go's own test, so the caps never count too few. */
export const asksGo = (text: string): boolean => /\bgo\b/i.test(text);

export type Verdict = { ok: true } | { ok: false; line: string };

export class Caps {
  private day = '';
  private goAsks = 0;
  private sent = 0;
  private trips = 0;
  /** Messages that asked Go, per visit. A visit lasts at most 12 hours. */
  private readonly visits = new Map<string, number>();

  constructor(readonly limits: CapLimits, private readonly now: () => Date = () => new Date()) {}

  /** Takes one thing sent into the room by a visit; a message that asks Go takes one of Go's asks too. A refusal counts nothing. */
  send(visit: string, toGo: boolean): Verdict {
    const line = this.refusal(visit, toGo);
    if (line) return { ok: false, line };
    this.sent += 1;
    if (toGo) {
      this.goAsks += 1;
      this.visits.set(visit, (this.visits.get(visit) ?? 0) + 1);
    }
    return { ok: true };
  }

  /** Takes one new trip. */
  newTrip(): Verdict {
    this.roll();
    if (this.trips >= this.limits.dailyTrips) return { ok: false, line: DAILY_LIMIT_LINE };
    this.trips += 1;
    return { ok: true };
  }

  /** The line a visit sees now, or null: today's limit, or this visit's limit for asking Go. */
  line(visit: string): string | null {
    return this.refusal(visit, true);
  }

  private refusal(visit: string, toGo: boolean): string | null {
    this.roll();
    if (this.sent >= this.limits.dailyMessages) return DAILY_LIMIT_LINE;
    if (!toGo) return null;
    if (this.goAsks >= this.limits.dailyGoAsks) return DAILY_LIMIT_LINE;
    if ((this.visits.get(visit) ?? 0) >= this.limits.sessionGoAsks) return sessionLimitLine(this.limits.sessionGoAsks);
    return null;
  }

  /** A new UTC day starts the daily counts again. */
  private roll(): void {
    const day = this.now().toISOString().slice(0, 10);
    if (day === this.day) return;
    this.day = day;
    this.goAsks = 0;
    this.sent = 0;
    this.trips = 0;
  }
}
