import type { ChargeInput, ChargeResult, Rail, RailFailReason } from './rail.js';

/** A rail that moves no money. Tests use it, and PAY_RAIL=fake uses it on stage when said out loud. */
export class FakeRail implements Rail {
  readonly kind = 'fake' as const;
  readonly charges: ChargeInput[] = [];
  private readonly done = new Map<string, ChargeResult>();

  constructor(public outcome: 'ok' | 'unknown' | RailFailReason = 'ok') {}

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const seen = this.done.get(input.idempotencyKey);
    if (seen) return seen;
    // No clear answer: nothing is recorded, so asking again with the same key can still settle it.
    if (this.outcome === 'unknown') return { unknown: 'fake' };
    this.charges.push(input);
    const result: ChargeResult =
      this.outcome === 'ok' ? { railRef: `fake_${input.idempotencyKey}` } : { failed: this.outcome };
    this.done.set(input.idempotencyKey, result);
    return result;
  }
}
