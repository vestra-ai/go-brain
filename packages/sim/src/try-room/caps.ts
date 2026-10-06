// The try room's caps, so visitors cannot run up a bill. Go can wake its model for anything said in the room (not only
// a message that names Go), for a vote, a card tap, the payer's yes or no, and a new trip, so each of those takes one
// turn from a single daily budget across every visitor, and from the visit's own share of it, so one visit cannot use
// up the day. Everything sent into the room, reactions included, also counts against a daily total. The counts live in
// memory and start again at UTC midnight (05:30 IST); a restart starts them too. Over a cap the room refuses and says
// so, and nothing reaches Go.
import { DAILY_LIMIT_LINE, visitLimitLine } from './words.js';

export interface CapLimits {
  /** What can wake Go's model, per UTC day across every visitor: messages, votes, taps, yes or no, new trips (TRY_DAILY_TURNS). */
  dailyTurns: number;
  /** Everything sent into the room per UTC day, reactions included (TRY_DAILY_MESSAGES). */
  dailyMessages: number;
  /** One visit's share of the day's turns, keyed to its cookie (TRY_VISIT_TURNS). */
  visitTurns: number;
}

export const DEFAULT_CAPS: CapLimits = { dailyTurns: 200, dailyMessages: 600, visitTurns: 30 };

export type Verdict = { ok: true } | { ok: false; line: string };

export class Caps {
  private day = '';
  private turns = 0;
  private sent = 0;
  /** Turns each visit took today. Only a visit that took a turn is here, so it never holds more than dailyTurns visits. */
  private readonly visits = new Map<string, number>();

  constructor(readonly limits: CapLimits, private readonly now: () => Date = () => new Date()) {}

  /** Takes one thing a visit sent into the room; `wakesGo` takes one turn as well. A refusal counts nothing. */
  send(visit: string, wakesGo: boolean): Verdict {
    this.roll();
    if (this.sent >= this.limits.dailyMessages) return { ok: false, line: DAILY_LIMIT_LINE };
    if (wakesGo) {
      const line = this.turnRefusal(visit);
      if (line) return { ok: false, line };
      this.takeTurn(visit);
    }
    this.sent += 1;
    return { ok: true };
  }

  /** Takes one turn for a visit's new trip: Go greets a new trip. */
  newTrip(visit: string): Verdict {
    this.roll();
    const line = this.turnRefusal(visit);
    if (line) return { ok: false, line };
    this.takeTurn(visit);
    return { ok: true };
  }

  /** The line a visit sees now, or null: today's limit, or this visit's share used up. */
  line(visit: string): string | null {
    this.roll();
    return this.sent >= this.limits.dailyMessages ? DAILY_LIMIT_LINE : this.turnRefusal(visit);
  }

  private turnRefusal(visit: string): string | null {
    if (this.turns >= this.limits.dailyTurns) return DAILY_LIMIT_LINE;
    if ((this.visits.get(visit) ?? 0) >= this.limits.visitTurns) return visitLimitLine(this.limits.visitTurns);
    return null;
  }

  private takeTurn(visit: string): void {
    this.turns += 1;
    this.visits.set(visit, (this.visits.get(visit) ?? 0) + 1);
  }

  /** A new UTC day starts the counts again. */
  private roll(): void {
    const day = this.now().toISOString().slice(0, 10);
    if (day === this.day) return;
    this.day = day;
    this.turns = 0;
    this.sent = 0;
    this.visits.clear();
  }
}
