/**
 * The person's ixigo login, watched so Go asks again the moment it ends. ixigo's web login can't be kept alive: its
 * server refuses the token about 9 h after the login (LOGIN_LIFE_MS; staging, 10 Oct), its page then deletes it, and
 * nothing in ixigo's web app renews it (its own scripts: no refresh call, the "at" cookie set for 20 years). So while a
 * person's browser is logged in (tasks/browsers.ts), Go loads ixigo's home page there every couple of hours
 * (login.keepAlive: LOGIN_CALLS, one page load) and reads whether it still holds. A page that booted with none of the
 * login's calls is read again CONFIRM_OUT_MS later before it counts (a slow box's calls can miss the grace); out, the
 * login ends on every trip of the person's and Go asks its person, once, in the trip (login.ts).
 *
 * Light on ixigo by design: our boxes share one address, which ixigo rate limits (429) when it sees too many loads at
 * once (9 Oct). One read per logged-in browser in AFTER_MS plus a fixed jitter of up to JITTER_MS (its own, from its id),
 * one browser at a time, a browser tried in the last TRY_AGAIN_MS never again before it, and any read of the login in the
 * meantime (a hand-off, I'm logged in, a booking's check) counts as one. It wakes a box no more often than that.
 */
import { createHash } from 'node:crypto';

/** How often Go looks for a login due a keep-alive read. */
export const KEEPALIVE_EVERY_MS = 20 * 60_000;
/** A login ixigo last confirmed this long ago is due a read: an ended login is found within about this, and its jitter. */
export const KEEPALIVE_AFTER_MS = 2 * 3600_000;
/** Each browser's own extra wait on top, so their reads never come together. */
export const KEEPALIVE_JITTER_MS = 20 * 60_000;
/** A quiet read (the page booted, none of the login's calls came) is read again this much later before it counts as out. */
export const CONFIRM_OUT_MS = 5 * 60_000;
/** A read that said nothing (ixigo's check, a page that timed out) is tried again no sooner than this. */
export const KEEPALIVE_TRY_AGAIN_MS = 60 * 60_000;

/** The browser's fixed share of KEEPALIVE_JITTER_MS, from its id. */
export function keepAliveJitter(userId: string): number {
  return createHash('sha256').update(userId).digest().readUInt32BE(0) % KEEPALIVE_JITTER_MS;
}

export interface LoginKeepAliveDeps {
  /** The browsers logged in whose login ixigo last confirmed before then, each with its newest live trip (browsers.ts). */
  loggedInSince: (before: Date) => Promise<Array<{ userId: string; tripId: string; at: Date }>>;
  /**
   * One read of ixigo's home page on the trip's browser (login.keepAlive). "quiet" asks for a second read, confirming:
   * that read ends the login and asks when it is quiet or out again.
   */
  status: (tripId: string, o?: { confirming?: boolean }) => Promise<unknown>;
  /** Whether Go reads ixigo.com at all (TRAVEL_MODE ixigo_web). */
  live: () => boolean;
  now: () => Date;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

export interface LoginKeepAlive {
  /** One pass: every browser due a read gets one, one at a time. */
  tick(): Promise<void>;
  start(everyMs?: number): void;
  stop(): void;
}

export function createLoginKeepAlive(d: LoginKeepAliveDeps): LoginKeepAlive {
  /** When each browser was last read here. */
  const tried = new Map<string, number>();
  /** Browsers whose last read was quiet, with the trip it was for and when: read again CONFIRM_OUT_MS on. */
  const quiet = new Map<string, { tripId: string; at: number }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;

  async function pass(): Promise<void> {
    if (!d.live()) return;
    const nowMs = d.now().getTime();
    // The second read of a quiet one, once its wait is over: quiet or out again ends the login and asks; in, nothing.
    for (const [userId, q] of [...quiet]) {
      if (nowMs - q.at < CONFIRM_OUT_MS) continue;
      quiet.delete(userId);
      tried.set(userId, nowMs);
      try {
        const said = await d.status(q.tripId, { confirming: true });
        d.log.info({ tripId: q.tripId, said }, "travel: the person's ixigo login read again after a quiet read");
      } catch (err) {
        d.log.warn({ err, tripId: q.tripId }, "travel: the person's ixigo login could not be read again");
      }
    }
    const due = await d.loggedInSince(new Date(nowMs - KEEPALIVE_AFTER_MS));
    for (const b of due) {
      if (quiet.has(b.userId)) continue;
      if (b.at.getTime() + KEEPALIVE_AFTER_MS + keepAliveJitter(b.userId) > nowMs) continue;
      const last = tried.get(b.userId);
      if (last !== undefined && nowMs - last < KEEPALIVE_TRY_AGAIN_MS) continue;
      tried.set(b.userId, nowMs);
      try {
        const said = await d.status(b.tripId);
        d.log.info({ tripId: b.tripId, said }, "travel: the person's ixigo login kept alive");
        if (said === 'quiet') {
          quiet.set(b.userId, { tripId: b.tripId, at: nowMs });
          // The second read comes when its wait is over, not at the next pass.
          setTimeout(() => void tick().catch(() => undefined), CONFIRM_OUT_MS).unref?.();
        }
      } catch (err) {
        d.log.warn({ err, tripId: b.tripId }, "travel: the person's ixigo login could not be kept alive");
      }
    }
  }

  /** One pass at a time: a slow one is not stacked on. */
  function tick(): Promise<void> {
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    tick,
    start(everyMs = KEEPALIVE_EVERY_MS) {
      if (timer) return;
      timer = setInterval(() => {
        void tick().catch((err: unknown) => d.log.warn({ err }, "travel: the ixigo login's keep-alive pass failed"));
      }, everyMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
