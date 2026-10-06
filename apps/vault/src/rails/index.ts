import type { StripeLike } from '../stripe-client.js';
import { FakeRail } from './fake-rail.js';
import type { Rail, RailKind, Rails } from './rail.js';
import { StripeTestRail } from './stripe-test-rail.js';

export function notReadyRail(kind: RailKind): Rail {
  return {
    kind,
    async charge() {
      return { failed: 'rail_not_ready' };
    },
    async find() {
      return { unknown: 'rail_not_ready' };
    },
  };
}

export function makeRails(o: {
  stripe: StripeLike;
  customerOf: (personId: string) => Promise<string | null>;
  fake?: FakeRail;
}): Rails {
  return {
    fake: o.fake ?? new FakeRail(),
    stripe_test: new StripeTestRail(o.stripe, o.customerOf),
    ixigo: notReadyRail('ixigo'),
  };
}
