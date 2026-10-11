/**
 * The Server team's rev 5 (R6): what a place is like, for the ideas on the home screen (place_info). Answered from the
 * places Go has learned (place_details, place-for.ts): a trip's destination, a place card's place, or one the operator
 * learned ahead through a trip of their own (POST /admin/places/learn). Never a page load here: the Server asks with no
 * trip, and only a trip has a computer. A place not learned yet, or kept before its months were, answers its name with
 * complete: false, so the Server keeps the idea's own image and asks again another day. No tag and no way there: ixigo's
 * guide says neither.
 */
import type { Place } from '@go/contract';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { bearerOf, sameToken } from '../admin/session.js';
import type { ToGoHandler } from '../door/handlers.js';
import type { ToGoResult } from '../door/methods.js';
import type { PlaceFor } from './place-for.js';
import { norm } from './recipes/places.js';

type Info = ToGoResult<'place_info'>;

/** The answer for these words, from what Go has learned. */
export async function placeInfo(pool: pg.Pool, name: string): Promise<Info> {
  const kept = (await pool.query<{ place: Place; best_months: number[] | null }>('select place, best_months from place_details where words = $1', [norm(name)])).rows[0];
  if (!kept) return { place: { name }, complete: false };
  return {
    place: kept.place,
    ...(kept.best_months?.length ? { best_months: kept.best_months } : {}),
    ...(kept.best_months === null ? { complete: false } : {}),
  };
}

export function placeInfoHandler(d: { pool: pg.Pool }): ToGoHandler<'place_info'> {
  return async (params) => placeInfo(d.pool, params.name);
}

export const LearnPlaceBody = z.object({ trip_id: z.string().min(1).max(64), name: z.string().min(1).max(120) });

const errorBody = (code: string, message: string) => ({ error: { code, message } });

/**
 * POST /admin/places/learn { trip_id, name }: the operator's way to learn a place before the Server's ideas ask for it,
 * through that trip's own computer (one box lookup and a guide load or two, as a trip's destination is learned). It answers
 * what place_info will. Closed unless ADMIN_TOKEN is set; the token comes as a bearer.
 */
export function registerPlaceLearn(
  app: FastifyInstance,
  d: { adminToken: string | undefined; pool: pg.Pool; placeFor: PlaceFor; live: () => boolean },
): void {
  app.post('/admin/places/learn', async (req, reply) => {
    if (!d.adminToken) return reply.code(404).send(errorBody('not_found', 'admin is not set up'));
    if (!sameToken(bearerOf(req), d.adminToken)) return reply.code(401).send(errorBody('bad_signature', 'admin token required'));
    const parsed = LearnPlaceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send(errorBody('invalid', z.prettifyError(parsed.error).slice(0, 500)));
    const b = parsed.data;
    if (!d.live()) return reply.code(409).send(errorBody('conflict', 'Go reads ixigo only when TRAVEL_MODE is ixigo_web.'));
    const trip = (await d.pool.query<{ gone: boolean }>('select gone_at is not null as gone from trips where trip_id = $1', [b.trip_id])).rows[0];
    if (!trip || trip.gone) return reply.code(404).send(errorBody('not_found', 'no such trip'));
    try {
      if (!(await d.placeFor(b.name, { tripId: b.trip_id }))) return reply.code(404).send(errorBody('not_found', 'ixigo does not know that place'));
    } catch (err) {
      return reply.code(502).send(errorBody('upstream', String(err).slice(0, 300)));
    }
    return reply.send(await placeInfo(d.pool, b.name));
  });
}
