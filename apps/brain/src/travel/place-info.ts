/**
 * The Server team's rev 5 (R6): what a place is like, for the ideas on the home screen (place_info). Answered from the
 * places Go has learned (place_details, place-for.ts): a trip's destination, a place card's place, or one the operator
 * learned ahead through a trip of their own (POST /admin/places/learn). Never a page load here: the Server asks with no
 * trip, and only a trip has a computer. A place not learned yet, or kept before its months were, answers its name with
 * complete: false, so the Server keeps the idea's own image and asks again another day. A place ixigo's place box can't
 * settle on (Kerala, Ladakh: many of its entries fit the words) is learned by ixigo's guide for the words alone, its photos
 * and best months with no map position, and kept apart (place_guides), so a trip's destination never resolves to one. No
 * tag and no way there: ixigo's guide says neither.
 */
import type { Place } from '@go/contract';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { bearerOf, sameToken } from '../admin/session.js';
import type { ToGoHandler } from '../door/handlers.js';
import type { ToGoResult } from '../door/methods.js';
import type { GuideOf, PlaceFor } from './place-for.js';
import { norm } from './recipes/places.js';

type Info = ToGoResult<'place_info'>;

type Kept = { place: Place; best_months: number[] | null };

/** The answer for these words, from what Go has learned: the place itself, else its guide alone. */
export async function placeInfo(pool: pg.Pool, name: string): Promise<Info> {
  const key = norm(name);
  const kept =
    (await pool.query<Kept>('select place, best_months from place_details where words = $1', [key])).rows[0] ??
    (await pool.query<Kept>('select place, best_months from place_guides where words = $1', [key])).rows[0];
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

/**
 * The Server's idea names that ixigo knows by other words (the prod warm, 11 Oct): its place box can't settle on them and
 * it has no guide under them, but it has one under these (/plan/leh-ladakh, /plan/andaman-and-nicobar). Learned from that
 * guide, kept under the Server's name. By the words as place_info keys them (norm).
 */
export const IXIGO_WORDS: ReadonlyMap<string, string> = new Map([['ladakh', 'Leh Ladakh'], ['andaman', 'Andaman and Nicobar']]);

const errorBody = (code: string, message: string) => ({ error: { code, message } });

/**
 * POST /admin/places/learn { trip_id, name }: the operator's way to learn a place before the Server's ideas ask for it,
 * through that trip's own computer (one box lookup and a guide load or two, as a trip's destination is learned; the guide
 * by the words alone when the box can't settle, or by ixigo's own words for a name in IXIGO_WORDS). It answers what
 * place_info will; a place already learned loads nothing.
 * 404 unknown_place: neither the box nor a guide knows the words. Closed unless ADMIN_TOKEN is set; the token comes as a
 * bearer.
 */
export function registerPlaceLearn(
  app: FastifyInstance,
  d: { adminToken: string | undefined; pool: pg.Pool; placeFor: PlaceFor; guideOf: GuideOf; live: () => boolean },
): void {
  /** ixigo's guide for the words alone, kept apart from trip destinations: false when it has no photo and no months. */
  const learnGuide = async (name: string, tripId: string, words = name): Promise<boolean> => {
    const g = await d.guideOf([words], tripId);
    if (g.months === null) throw new Error("ixigo's guide did not load");
    if (!g.photo && g.months.length === 0) return false;
    const place: Place = { name: (g.name ?? name).slice(0, 120), ...(g.photo ? { photo_url: g.photo } : {}), ...(g.photos.length ? { photos: g.photos } : {}) };
    await d.pool.query(
      `insert into place_guides (words, place, best_months) values ($1, $2, $3)
       on conflict (words) do update set place = excluded.place, best_months = excluded.best_months, learned_at = now()`,
      [norm(name), place, g.months],
    );
    return true;
  };

  app.post('/admin/places/learn', async (req, reply) => {
    if (!d.adminToken) return reply.code(404).send(errorBody('not_found', 'admin is not set up'));
    if (!sameToken(bearerOf(req), d.adminToken)) return reply.code(401).send(errorBody('bad_signature', 'admin token required'));
    const parsed = LearnPlaceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send(errorBody('invalid', z.prettifyError(parsed.error).slice(0, 500)));
    const b = parsed.data;
    if (!d.live()) return reply.code(409).send(errorBody('conflict', 'Go reads ixigo only when TRAVEL_MODE is ixigo_web.'));
    const trip = (await d.pool.query<{ gone: boolean }>('select gone_at is not null as gone from trips where trip_id = $1', [b.trip_id])).rows[0];
    if (!trip || trip.gone) return reply.code(404).send(errorBody('not_found', 'no such trip'));
    const kept = await placeInfo(d.pool, b.name);
    if (kept.complete !== false) return reply.send(kept);
    try {
      const words = IXIGO_WORDS.get(norm(b.name));
      const known = words
        ? await learnGuide(b.name, b.trip_id, words)
        : (await d.placeFor(b.name, { tripId: b.trip_id })) !== null || (await learnGuide(b.name, b.trip_id));
      if (!known) return reply.code(404).send(errorBody('unknown_place', "neither ixigo's place box nor its guide knows that place"));
    } catch (err) {
      return reply.code(502).send(errorBody('upstream', String(err).slice(0, 300)));
    }
    return reply.send(await placeInfo(d.pool, b.name));
  });
}
