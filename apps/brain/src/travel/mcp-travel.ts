/**
 * A TravelBackend over any MCP caller and mapping table. FakeTravel is the fake ixigo in process; IxigoTravel is
 * ixigo's MCP server over HTTP. Offer and hold ids carry the backend as a prefix ("fake:", "ixigo:"), so the layer
 * routes a hold or a confirm to the backend that made the offer, whatever TRAVEL_MODE says now. A confirm is safe to
 * repeat: each hold's booking is kept by its hold id, and a backend that can look a hold's booking up is asked first.
 */
import type { FakeIxigoStore } from './fake-ixigo/data.js';
import { DEFAULT_IXIGO_MAP, IXIGO_MAP, type HoldMapped, type IxigoMap } from './ixigo-map.js';
import { createHttpMcpCaller, createInProcessCaller, type McpCaller } from './mcp-caller.js';
import type { Confirmed, Hold, TravelBackend, TravelKind, TravelOption } from './travel.js';

/** Confirmed bookings kept per process, by hold id. */
const CONFIRMED_MAX = 1_000;

export class TravelError extends Error {
  constructor(readonly code: 'needs_more' | 'unreachable' | 'refused' | 'unknown_offer', message: string) {
    super(message);
    this.name = 'TravelError';
  }
}

const NEEDS: Record<TravelKind, string> = {
  flights: 'A flight search needs where from, where to and the date.',
  trains: 'A train search needs where from, where to and the date.',
  buses: 'A bus search needs where from, where to and the date.',
  stays: 'A stay search needs the place, check-in and check-out.',
};

export interface McpTravelOptions {
  backend: 'fake' | 'ixigo';
  caller: McpCaller;
  map: IxigoMap;
  now: () => Date;
  payment: (hold: HoldMapped) => Hold['payment'];
}

export function createMcpTravel(o: McpTravelOptions): TravelBackend {
  const prefix = `${o.backend}:`;
  // One booking per hold: a second confirm for the same hold (or one at the same moment) gets the first one's answer.
  const confirmed = new Map<string, Promise<Confirmed>>();
  const own = (id: string, what: string): string => {
    if (!id.startsWith(prefix)) throw new TravelError('unknown_offer', `${what} ${id} is not from ${o.backend}.`);
    return id.slice(prefix.length);
  };
  /** readOnly: searches, status and lookups may be sent again after a dropped connection; a hold or a confirm never is. */
  const call = async (tool: string, args: Record<string, unknown>, readOnly = false): Promise<unknown> => {
    const r = await o.caller.call(tool, args, { readOnly });
    if (r.isError) throw new TravelError(r.data === null ? 'unreachable' : 'refused', r.text.slice(0, 300));
    return r.data;
  };
  const mapped = <T>(what: string, read: () => T): T => {
    try {
      return read();
    } catch (err) {
      if (err instanceof TravelError) throw err;
      throw new TravelError('refused', `${o.backend} answered ${what} in a shape Go does not read: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`);
    }
  };
  return {
    async search(kind, q) {
      const m = o.map.search[kind];
      // A kind this backend's map has no search for (a real ixigo map without trains or buses): a plain refusal, never a crash.
      if (!m) throw new TravelError('refused', `Go cannot search ${kind} yet.`);
      const args = m.args(q);
      if (!args) throw new TravelError('needs_more', NEEDS[kind]);
      const checkedAt = o.now().toISOString();
      const data = await call(m.tool, args, true);
      const results = mapped(`a ${kind} search`, () => m.results(data)).map(({ backendId, ...rest }): TravelOption => ({ ...rest, offerId: prefix + backendId }));
      return { results, checkedAt };
    },
    async status(q) {
      const checkedAt = o.now().toISOString();
      if (q.kind === 'flight') {
        const m = o.map.flightStatus;
        const data = await call(m.tool, m.args(q), true);
        return mapped('a flight status', () => m.result(data, checkedAt));
      }
      const m = o.map.pnrStatus;
      const data = await call(m.tool, m.args(q), true);
      return mapped('a booking status', () => m.result(data, checkedAt));
    },
    async hold(offerId, lead) {
      const m = o.map.hold;
      const data = await call(m.tool, m.args(own(offerId, 'Offer'), { name: lead.name, travellers: Math.max(1, lead.personIds.length) }));
      const h = mapped('a hold', () => m.result(data));
      return {
        holdId: prefix + h.backendHoldId, amountMinor: h.amountMinor, currency: h.currency, merchant: h.merchant, expiresAt: h.expiresAt,
        ...(h.refundableUntil ? { refundableUntil: h.refundableUntil } : {}),
        payment: o.payment(h),
      };
    },
    confirm(holdId, paid) {
      const known = confirmed.get(holdId);
      if (known) return known;
      const run = (async (): Promise<Confirmed> => {
        const backendHoldId = own(holdId, 'Hold');
        const lookup = o.map.bookingForHold;
        if (lookup) {
          // A confirm that reached the backend before a restart or a lost answer is not sent again.
          const found = await call(lookup.tool, lookup.args(backendHoldId), true);
          const booking = mapped('a booking lookup', () => lookup.result(found));
          if (booking) return booking;
        }
        const m = o.map.confirm;
        const data = await call(m.tool, m.args(backendHoldId, paid));
        return mapped('a booking', () => m.result(data));
      })();
      confirmed.set(holdId, run);
      // A failed confirm is not kept, so the next try asks again.
      run.catch(() => confirmed.delete(holdId));
      while (confirmed.size > CONFIRMED_MAX) {
        const oldest = confirmed.keys().next().value;
        if (oldest === undefined) break;
        confirmed.delete(oldest);
      }
      return run;
    },
  };
}

/** The fake ixigo in this process. Its holds are paid on the rail the PAY_RAIL switch names. */
export function createFakeTravel(o: { store: FakeIxigoStore; now: () => Date; payRail: () => string }): TravelBackend {
  return createMcpTravel({
    backend: 'fake',
    caller: createInProcessCaller(o.store),
    map: DEFAULT_IXIGO_MAP,
    now: o.now,
    payment: () => (o.payRail() === 'stripe_test' ? { kind: 'stripe_test' } : { kind: 'fake' }),
  });
}

/** ixigo's MCP server. A hold that comes with ixigo's payment token is paid through ixigo; otherwise on Stripe test. */
export function createIxigoTravel(o: { url: string; token?: string; now: () => Date; caller?: McpCaller; map?: IxigoMap }): TravelBackend {
  return createMcpTravel({
    backend: 'ixigo',
    caller: o.caller ?? createHttpMcpCaller({ url: o.url, name: 'go-ixigo', ...(o.token ? { token: o.token } : {}) }),
    map: o.map ?? IXIGO_MAP,
    now: o.now,
    payment: (h) => (h.paymentToken ? { kind: 'ixigo', token: h.paymentToken } : { kind: 'stripe_test' }),
  });
}
