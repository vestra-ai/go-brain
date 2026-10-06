// The try room's caps, so visitors cannot run up a bill. Go can wake its model for anything said in the room (not only
// a message that names Go), for a vote, a card tap, the payer's yes or no, and a new trip, so each of those takes one
// turn from a single daily budget across every visitor. Everything sent into the room, reactions included, also counts
// against a daily total. The counts live in memory and start again at UTC midnight (05:30 IST); a restart starts them
// too. Over a cap the room refuses and says so, and nothing reaches Go.
import { DAILY_LIMIT_LINE } from './words.js';

export interface CapLimits {
  /** What can wake Go's model, per UTC day across every visitor: messages, votes, taps, yes or no, new trips (TRY_DAILY_TURNS). */
  dailyTurns: number;
  /** Everything sent into the room per UTC day, reactions included (TRY_DAILY_MESSAGES). */
  dailyMessages: number;
}

export const DEFAULT_CAPS: CapLimits = { dailyTurns: 200, dailyMessages: 600 };

export type Verdict = { ok: true } | { ok: false; line: string };

export class Caps {
  private day = '';
  private turns = 0;
  private sent = 0;

  constructor(readonly limits: CapLimits, private readonly now: () => Date = () => new Date()) {}

  /** Takes one thing sent into the room; `wakesGo` takes one turn as well. A refusal counts nothing. */
  send(wakesGo: boolean): Verdict {
    this.roll();
    if (this.sent >= this.limits.dailyMessages || (wakesGo && this.turns >= this.limits.dailyTurns)) return { ok: false, line: DAILY_LIMIT_LINE };
    this.sent += 1;
    if (wakesGo) this.turns += 1;
    return { ok: true };
  }

  /** Takes one turn for a new trip: Go greets a new trip. */
  newTrip(): Verdict {
    this.roll();
    if (this.turns >= this.limits.dailyTurns) return { ok: false, line: DAILY_LIMIT_LINE };
    this.turns += 1;
    return { ok: true };
  }

  /** The line every visitor sees once nothing more can wake Go today, or null. */
  line(): string | null {
    this.roll();
    return this.turns >= this.limits.dailyTurns || this.sent >= this.limits.dailyMessages ? DAILY_LIMIT_LINE : null;
  }

  /** A new UTC day starts the counts again. */
  private roll(): void {
    const day = this.now().toISOString().slice(0, 10);
    if (day === this.day) return;
    this.day = day;
    this.turns = 0;
    this.sent = 0;
  }
}
