// Moves due candidates through the bar onto the desk. Only a candidate that passes becomes a desk item,
// so a nudge the bar refuses never costs a model turn.
import type { Desk } from '../desk/desk.js';
import type { Packs, TripPack } from '../trips/pack.js';
import { localDay } from './clock.js';
import { deskId, toPayload } from './payload.js';
import { decideBatch, type Candidate, type TripMood } from './policy.js';
import type { ProactiveStore, Signals } from './store.js';
import { stillTrue } from './timers.js';

export function moodFrom(sig: Signals, pack: TripPack, tz: string): TripMood {
  let lastPerson: string | null = null;
  let lastGo: string | null = null;
  for (const m of pack.messages) {
    if (m.deleted) continue;
    if (m.author.kind === 'person' && (lastPerson === null || m.sent_at > lastPerson)) lastPerson = m.sent_at;
    if (m.author.kind === 'go' && (lastGo === null || m.sent_at > lastGo)) lastGo = m.sent_at;
  }
  return {
    tz,
    postsToday: sig.postsToday,
    lastProactivePostAt: sig.lastProactivePostAt,
    lastGoMessageAt: lastGo ? new Date(lastGo) : null,
    lastPersonMessageAt: lastPerson ? new Date(lastPerson) : null,
    hushCount: sig.hushCount,
    lastHushAt: sig.lastHushAt,
    ignoredCount: sig.ignoredCount,
    pausedPersonIds: pack.trip.people.filter((p) => p.go_paused).map((p) => p.person_id),
  };
}

export interface PromoterDeps {
  store: ProactiveStore;
  desk: Pick<Desk, 'put'>;
  packs: Pick<Packs, 'get'>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
}

export interface Promoter {
  /** One pass over every trip. A pass already running is joined, never doubled. */
  tick(): Promise<number>;
  /** This trip's due candidates now, queued behind a pass that is running (the stage fire). */
  promoteTrip(tripId: string): Promise<number>;
}

export function createPromoter(deps: PromoterDeps): Promoter {
  let running: Promise<number> | null = null;
  // Passes run one at a time, so a trip's candidates are never decided by two passes at once.
  let tail: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };

  async function decideTrip(tripId: string, cands: Candidate[], now: Date): Promise<number> {
    const pack = await deps.packs.get(tripId);
    const tz = await deps.store.tripTz(tripId);
    const day = localDay(now, tz);
    const mood = moodFrom(await deps.store.signals(tripId, day), pack, tz);
    const live: Candidate[] = [];
    for (const c of cands) {
      const check = stillTrue(c, pack);
      if (!check.ok) {
        await deps.store.drop(c, 'no_longer_true', now);
        continue;
      }
      live.push({ ...c, personIds: check.personIds });
    }
    let promoted = 0;
    for (const { candidate, decision } of decideBatch(live, mood, now)) {
      if (decision.kind === 'drop') {
        await deps.store.drop(candidate, decision.reason, now);
        continue;
      }
      if (decision.kind === 'wait') {
        await deps.store.defer(candidate, decision.until, decision.reason);
        continue;
      }
      const id = deskId(candidate);
      await deps.desk.put({ id, tripId, kind: candidate.source, ref: id, dueAt: now, payload: toPayload(candidate, decision, tz) });
      await deps.store.promote(candidate, { allowed: decision.allowed, forPersonIds: decision.forPersonIds, counted: decision.counted, localDay: day }, now);
      promoted += 1;
    }
    return promoted;
  }

  async function once(): Promise<number> {
    const now = deps.now();
    const byTrip = new Map<string, Candidate[]>();
    for (const c of await deps.store.due(now)) byTrip.set(c.tripId, [...(byTrip.get(c.tripId) ?? []), c]);
    let promoted = 0;
    for (const [tripId, cands] of byTrip) {
      try {
        promoted += await decideTrip(tripId, cands, now);
      } catch (err) {
        deps.log.warn({ err, tripId }, 'proactive: promote failed; the candidates stay due');
      }
    }
    return promoted;
  }

  return {
    tick(): Promise<number> {
      if (!running) running = inTurn(once).finally(() => { running = null; });
      return running;
    },
    promoteTrip(tripId: string): Promise<number> {
      return inTurn(async () => {
        const now = deps.now();
        const cands = await deps.store.dueFor(tripId, now);
        return cands.length > 0 ? decideTrip(tripId, cands, now) : 0;
      });
    },
  };
}
