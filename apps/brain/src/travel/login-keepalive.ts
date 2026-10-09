/**
 * The person's ixigo login kept alive. ixigo's app refreshes its session as it is used; a browser nobody reads ixigo in
 * for days lets it lapse. So while a person's browser is logged in (tasks/browsers.ts), Go loads ixigo's home page there
 * once every few hours (login.status: LOGIN_CALLS, one page load), which refreshes the session as a visit does, and says
 * whether it still holds. A token ixigo refuses (401 or 403) ends the login on every trip of the person's, and the next
 * booking that needs it asks again.
 *
 * Light on ixigo by design: our boxes share one address, which ixigo rate limits (429) when it sees too many loads at
 * once (9 Oct). One read per logged-in browser in AFTER_MS plus a fixed jitter of up to JITTER_MS (its own, from its id),
 * one browser at a time, a browser tried in the last TRY_AGAIN_MS never again before it, and any read of the login in the
 * meantime (a hand-off, I'm logged in, a booking's check) counts as one. It wakes a box no more often than that.
 */
import { createHash } from 'node:crypto';

/** How often Go looks for a login due a keep-alive read. */
export const KEEPALIVE_EVERY_MS = 20 * 60_000;
/** A login ixigo last confirmed this long ago is due a read. */
export const KEEPALIVE_AFTER_MS = 4 * 3600_000;
/** Each browser's own extra wait on top, so their reads never come together. */
export const KEEPALIVE_JITTER_MS = 40 * 60_000;
/** A read that said nothing (ixigo's check, a page that timed out) is tried again no sooner than this. */
export const KEEPALIVE_TRY_AGAIN_MS = 60 * 60_000;

/** The browser's fixed share of KEEPALIVE_JITTER_MS, from its id. */
export function keepAliveJitter(userId: string): number {
  return createHash('sha256').update(userId).digest().readUInt32BE(0) % KEEPALIVE_JITTER_MS;
}

export interface LoginKeepAliveDeps {
  /** The browsers logged in whose login ixigo last confirmed before then, each with its newest live trip (browsers.ts). */
  loggedInSince: (before: Date) => Promise<Array<{ userId: string; tripId: string; at: Date }>>;
  /** One read of ixigo's home page on the trip's browser (login.status), which keeps what it says. */
  status: (tripId: string) => Promise<unknown>;
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
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;

  async function pass(): Promise<void> {
    if (!d.live()) return;
    const nowMs = d.now().getTime();
    const due = await d.loggedInSince(new Date(nowMs - KEEPALIVE_AFTER_MS));
    for (const b of due) {
      if (b.at.getTime() + KEEPALIVE_AFTER_MS + keepAliveJitter(b.userId) > nowMs) continue;
      const last = tried.get(b.userId);
      if (last !== undefined && nowMs - last < KEEPALIVE_TRY_AGAIN_MS) continue;
      tried.set(b.userId, nowMs);
      try {
        const said = await d.status(b.tripId);
        d.log.info({ tripId: b.tripId, said }, "travel: the person's ixigo login kept alive");
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
