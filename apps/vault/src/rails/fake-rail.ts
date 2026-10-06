import type { ChargeInput, ChargeResult, FindResult, Rail, RailFailReason } from './rail.js';

/** A rail that moves no money. Tests use it, and PAY_RAIL=fake uses it on stage when said out loud. */
export class FakeRail implements Rail {
  readonly kind = 'fake' as const;
  /** Every charge that moved (fake) money. */
  readonly charges: ChargeInput[] = [];
  /** The idempotency key of every charge() call, whether or not money moved. */
  readonly asked: string[] = [];
  /** How find() answers: from what was recorded, or a test's 'unknown' or 'throw'. */
  findAnswer: 'record' | 'unknown' | 'throw' = 'record';
  private readonly done = new Map<string, ChargeResult>();

  /** 'lost': the charge goes through, but its answer is lost on the way back (the caller hears unknown). */
  constructor(public outcome: 'ok' | 'unknown' | 'lost' | RailFailReason = 'ok') {}

  async charge(input: ChargeInput): Promise<ChargeResult> {
    this.asked.push(input.idempotencyKey);
    const seen = this.done.get(input.idempotencyKey);
    if (seen) return seen;
    // No clear answer: nothing is recorded, so asking again with the same key can still settle it.
    if (this.outcome === 'unknown') return { unknown: 'fake' };
    if (this.outcome === 'lost') {
      this.charges.push(input);
      this.done.set(input.idempotencyKey, { railRef: `fake_${input.idempotencyKey}` });
      return { unknown: 'fake' };
    }
    this.charges.push(input);
    const result: ChargeResult =
      this.outcome === 'ok' ? { railRef: `fake_${input.idempotencyKey}` } : { failed: this.outcome };
    this.done.set(input.idempotencyKey, result);
    return result;
  }

  async find(idempotencyKey: string): Promise<FindResult> {
    if (this.findAnswer === 'throw') throw new Error('the fake rail could not be reached');
    if (this.findAnswer === 'unknown') return { unknown: 'fake' };
    const seen = this.done.get(idempotencyKey);
    return seen && 'railRef' in seen ? { railRef: seen.railRef } : { none: true };
  }
}
