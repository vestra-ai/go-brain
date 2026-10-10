import { describe, expect, it, vi } from 'vitest';
import {
  CONFIRM_OUT_MS, createLoginKeepAlive, KEEPALIVE_AFTER_MS, KEEPALIVE_EVERY_MS, KEEPALIVE_FIRST_MS, KEEPALIVE_JITTER_MS, KEEPALIVE_TRY_AGAIN_MS, keepAliveJitter,
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
  it('reads each logged-in browser once its login is older than 2 h plus its own jitter, one at a time, and not again until the next', async () => {
    const a = { userId: 'gobrowser-a', tripId: 't_a', at: T0 - KEEPALIVE_AFTER_MS - KEEPALIVE_JITTER_MS };
    const b = { userId: 'gobrowser-b', tripId: 't_b', at: T0 - KEEPALIVE_AFTER_MS - KEEPALIVE_JITTER_MS };
    // Confirmed just now (a hand-off, a booking's check): not due.
    const fresh = { userId: 'gobrowser-c', tripId: 't_c', at: T0 };
    const w = world([a, b, fresh]);
    await w.keep.tick();
    expect(w.reads).toEqual(['t_a', 't_b']);
    expect(w.most()).toBe(1);
    // Read now: not due again for another 2 h and its jitter.
    w.advance(KEEPALIVE_AFTER_MS);
    await w.keep.tick();
    expect(w.reads).toEqual(['t_a', 't_b']);
    w.advance(KEEPALIVE_JITTER_MS + 1);
    await w.keep.tick();
    expect(w.reads).toEqual(['t_a', 't_b', 't_a', 't_b', 't_c']);
  });

  it("waits its own jitter past the 2 h, so browsers logged in at once are never read at once", async () => {
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

  // 10 Oct: a logged-out page boots with none of the login's calls, and that reads quiet; a slow box's calls can miss the
  // grace too. So a quiet read is read again CONFIRM_OUT_MS on, confirming: only then does the login end and Go ask.
  it('reads a quiet browser again after CONFIRM_OUT_MS, confirming; one quiet read then in does nothing more', async () => {
    let nowMs = T0;
    const asked: Array<{ tripId: string; confirming: boolean }> = [];
    const answers: Record<string, string[]> = { t_gone: ['quiet', 'out'], t_slow: ['quiet', 'in'] };
    const keep = createLoginKeepAlive({
      loggedInSince: async () => [
        { userId: 'gobrowser-gone', tripId: 't_gone', at: new Date(T0 - KEEPALIVE_AFTER_MS - KEEPALIVE_JITTER_MS) },
        { userId: 'gobrowser-slow', tripId: 't_slow', at: new Date(T0 - KEEPALIVE_AFTER_MS - KEEPALIVE_JITTER_MS) },
      ],
      status: async (tripId, o) => {
        asked.push({ tripId, confirming: o?.confirming === true });
        return answers[tripId]!.shift();
      },
      live: () => true,
      now: () => new Date(nowMs),
      log: { info: () => undefined, warn: () => undefined },
    });
    await keep.tick();
    expect(asked).toEqual([{ tripId: 't_gone', confirming: false }, { tripId: 't_slow', confirming: false }]);
    // Not yet: the second read waits its CONFIRM_OUT_MS, and a quiet browser is never read as a due one meanwhile.
    nowMs += CONFIRM_OUT_MS - 1;
    await keep.tick();
    expect(asked).toHaveLength(2);
    nowMs += 1;
    await keep.tick();
    expect(asked.slice(2)).toEqual([{ tripId: 't_gone', confirming: true }, { tripId: 't_slow', confirming: true }]);
    // Each is read again once only: the confirming read decides (login.keepAlive ends a confirmed one and asks).
    nowMs += CONFIRM_OUT_MS;
    await keep.tick();
    expect(asked).toHaveLength(4);
    keep.stop();
  });

  // 10 Oct: Go deploys often, and a pass only on the 20-minute beat put a due read off by up to 20 minutes after each.
  it('makes its first pass a minute after it starts, then one every KEEPALIVE_EVERY_MS', async () => {
    vi.useFakeTimers();
    try {
      const w = world([{ userId: 'gobrowser-due', tripId: 't_due', at: T0 - KEEPALIVE_AFTER_MS - KEEPALIVE_JITTER_MS }]);
      w.keep.start();
      await vi.advanceTimersByTimeAsync(KEEPALIVE_FIRST_MS - 1);
      expect(w.reads).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(w.reads).toEqual(['t_due']);
      expect(KEEPALIVE_FIRST_MS).toBeLessThan(KEEPALIVE_EVERY_MS);
      w.keep.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
