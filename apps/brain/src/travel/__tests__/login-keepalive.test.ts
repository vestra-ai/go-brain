import { describe, expect, it } from 'vitest';
import {
  createLoginKeepAlive, KEEPALIVE_AFTER_MS, KEEPALIVE_JITTER_MS, KEEPALIVE_TRY_AGAIN_MS, keepAliveJitter,
} from '../login-keepalive.js';

// The person's ixigo login kept alive in their browser: one read every few hours while it is logged in, light on the
// shared address ixigo rate limits (9 Oct: 429 when several of us read at once).
const T0 = Date.parse('2026-10-09T18:00:00Z');

function world(browsers: Array<{ userId: string; tripId: string; at: number }>, o: { live?: boolean } = {}) {
  let nowMs = T0;
  const reads: string[] = [];
  let inFlight = 0;
  let most = 0;
  const keep = createLoginKeepAlive({
    loggedInSince: async (before) => browsers.filter((b) => b.at < before.getTime()).map((b) => ({ ...b, at: new Date(b.at) })),
    status: async (tripId) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      reads.push(tripId);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      // A read that says in confirms the login now.
      const b = browsers.find((x) => x.tripId === tripId);
      if (b) b.at = nowMs;
      return 'in';
    },
    live: () => o.live !== false,
    now: () => new Date(nowMs),
    log: { info: () => undefined, warn: () => undefined },
  });
  return { keep, reads, most: () => most, advance: (ms: number) => { nowMs += ms; } };
}

describe("the person's ixigo login, kept alive", () => {
  it('reads each logged-in browser once its login is older than 4 h plus its own jitter, one at a time, and not again until the next', async () => {
    const a = { userId: 'gobrowser-a', tripId: 't_a', at: T0 - KEEPALIVE_AFTER_MS - KEEPALIVE_JITTER_MS };
    const b = { userId: 'gobrowser-b', tripId: 't_b', at: T0 - KEEPALIVE_AFTER_MS - KEEPALIVE_JITTER_MS };
    // Confirmed just now (a hand-off, a booking's check): not due.
    const fresh = { userId: 'gobrowser-c', tripId: 't_c', at: T0 };
    const w = world([a, b, fresh]);
    await w.keep.tick();
    expect(w.reads).toEqual(['t_a', 't_b']);
    expect(w.most()).toBe(1);
    // Read now: not due again for another 4 h and its jitter.
    w.advance(KEEPALIVE_AFTER_MS);
    await w.keep.tick();
    expect(w.reads).toEqual(['t_a', 't_b']);
    w.advance(KEEPALIVE_JITTER_MS + 1);
    await w.keep.tick();
    expect(w.reads).toEqual(['t_a', 't_b', 't_a', 't_b', 't_c']);
  });

  it("waits its own jitter past the 4 h, so browsers logged in at once are never read at once", async () => {
    const id = 'gobrowser-jitter';
    expect(keepAliveJitter(id)).toBeGreaterThanOrEqual(0);
    expect(keepAliveJitter(id)).toBeLessThan(KEEPALIVE_JITTER_MS);
    expect(keepAliveJitter(id)).toBe(keepAliveJitter(id));
    const w = world([{ userId: id, tripId: 't_j', at: T0 - KEEPALIVE_AFTER_MS - keepAliveJitter(id) + 1_000 }]);
    await w.keep.tick();
    expect(w.reads).toEqual([]);
    w.advance(1_000);
    await w.keep.tick();
    expect(w.reads).toEqual(['t_j']);
  });

  it('a read that said nothing is tried again no sooner than an hour on; and none while Go reads no ixigo.com', async () => {
    const stuck = { userId: 'gobrowser-stuck', tripId: 't_s', at: T0 - KEEPALIVE_AFTER_MS - KEEPALIVE_JITTER_MS };
    const w = world([]);
    const silent = createLoginKeepAlive({
      loggedInSince: async () => [{ ...stuck, at: new Date(stuck.at) }],
      status: async (tripId) => {
        w.reads.push(tripId);
        return 'unknown';
      },
      live: () => true,
      now: () => new Date(T0 + (w.reads.length >= 1 ? KEEPALIVE_TRY_AGAIN_MS - 1 : 0)),
      log: { info: () => undefined, warn: () => undefined },
    });
    await silent.tick();
    await silent.tick();
    expect(w.reads).toEqual(['t_s']);

    const off = world([stuck], { live: false });
    await off.keep.tick();
    expect(off.reads).toEqual([]);
  });
});
