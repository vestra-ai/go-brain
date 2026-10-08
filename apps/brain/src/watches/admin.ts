// POST /admin/watch/fire: the demo's simulated watch. Without force it goes through the same bar as a real one; with
// force (the stage) it skips the bar, the budget, "two in a row" and the hush for this nudge only. Every card Go posts
// from it says "Simulated for the demo", and a double click posts once.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localDay } from '../proactive/clock.js';
import type { Candidate } from '../proactive/policy.js';
import type { ProactiveStore } from '../proactive/store.js';
import { TripGoneError } from '../trips/gone.js';

/** The same fire within this window (or the one before) is a double click. */
export const FIRE_WINDOW_MS = 60_000;

export const FireWatchBody = z.object({
  trip_id: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  person_ids: z.array(z.string().min(1).max(64)).max(30).default([]),
  /** P4's flight status words. */
  state: z.enum(['scheduled', 'delayed', 'cancelled', 'departed', 'landed']).default('delayed'),
  delay_minutes: z.int().min(0).max(1440).default(120),
  arrive_at: z.iso.datetime({ offset: true }).optional(),
  note: z.string().min(1).max(200).optional(),
  importance: z.number().min(0).max(1).default(0.9),
  urgency: z.number().min(0).max(1).default(0.9),
  /** Rehearsals: today's earlier unprompted posts stop counting first. */
  reset_budget: z.boolean().default(false),
  /** The stage: this nudge skips the bar, the budget, "two in a row", hush and ignored raises. Still labelled and pinned. */
  force: z.boolean().default(false),
});
type FireWatch = z.infer<typeof FireWatchBody>;

/** The candidate's key: the body (all but reset_budget) and the minute it arrived, so a double click maps to one key. */
export function fireKey(b: FireWatch, minute: number): string {
  const what = JSON.stringify([b.trip_id, b.label, b.person_ids, b.state, b.delay_minutes, b.arrive_at ?? null, b.note ?? null, b.importance, b.urgency, b.force]);
  return `sim:flight_status:${createHash('sha256').update(what).digest('hex').slice(0, 12)}:${minute}`;
}

export interface FireDeps {
  adminToken: string | undefined;
  store: ProactiveStore;
  now: () => Date;
  /** Promotes this trip's due candidates now, behind any pass already running. */
  promote: (tripId: string) => Promise<number>;
}

function sameToken(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export function registerFireRoute(app: FastifyInstance, d: FireDeps): void {
  app.post('/admin/watch/fire', async (req, reply) => {
    if (!d.adminToken) return reply.code(404).send(errorBody('not_found', 'admin is not set up'));
    const given = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!sameToken(given, d.adminToken)) return reply.code(401).send(errorBody('bad_signature', 'admin token required'));
    const parsed = FireWatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send(errorBody('invalid', z.prettifyError(parsed.error).slice(0, 500)));
    const b = parsed.data;
    const state = await d.store.tripState(b.trip_id);
    if (state === null) return reply.code(404).send(errorBody('not_found', 'no such trip'));
    if (state === 'gone') return reply.code(404).send(errorBody('not_found', 'that trip is gone'));

    const now = d.now();
    const minute = Math.floor(now.getTime() / FIRE_WINDOW_MS);
    const dedupeKey = fireKey(b, minute);
    // A double click that straddles a minute: the same fire a moment ago is in the minute before.
    const earlier = fireKey(b, minute - 1);
    if (await d.store.status(b.trip_id, earlier)) return reply.send({ ok: true, dedupe_key: earlier, duplicate: true, promoted: 0 });
    if (await d.store.status(b.trip_id, dedupeKey)) return reply.send({ ok: true, dedupe_key: dedupeKey, duplicate: true, promoted: 0 });
    if (b.reset_budget) await d.store.resetBudget(b.trip_id, localDay(now, await d.store.tripTz(b.trip_id)));
    const c: Candidate = {
      tripId: b.trip_id,
      dedupeKey,
      source: 'watch',
      topic: 'flight_status',
      dueAt: now,
      expiresAt: new Date(now.getTime() + 2 * 3600_000),
      importance: b.importance,
      confidence: 1,
      urgency: b.urgency,
      // Pinned to the people it names, never a message to everyone: the label and the pins ride on the notice card.
      useful: b.person_ids.length > 0 ? ['pin'] : ['message'],
      personIds: b.person_ids,
      facts: {
        label: b.label,
        state: b.state,
        delayMinutes: b.delay_minutes,
        simulated: true,
        ...(b.arrive_at ? { arriveAt: b.arrive_at } : {}),
        ...(b.note ? { note: b.note } : {}),
      },
      simulated: true,
      small: false,
      ...(b.force ? { forced: true } : {}),
    };
    // Two clicks at the same moment: one insert wins, the other is the double click.
    if ((await d.store.add(c)) === 'exists') return reply.send({ ok: true, dedupe_key: dedupeKey, duplicate: true, promoted: 0 });
    try {
      await d.promote(b.trip_id);
    } catch (err) {
      // The Server forgot the trip between the check and the pass: the same answer as a trip already gone.
      if (err instanceof TripGoneError) return reply.code(404).send(errorBody('not_found', 'that trip is gone'));
      throw err;
    }
    // The answer is about this fire only, whatever else the pass promoted.
    const promoted = (await d.store.status(b.trip_id, dedupeKey))?.status === 'promoted' ? 1 : 0;
    return reply.send({ ok: true, dedupe_key: dedupeKey, promoted });
  });
}
