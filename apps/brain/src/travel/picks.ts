// Each person's own ticket pick: a flight, train or bus (PERSONAL_KINDS) they tapped "I'll take this" on, one per way they
// travel, so a later pick of the same way ("Change") replaces it. A pick is theirs, never the group's: it feeds their
// booking, and a flight's lets the watches give them the heads-up when it runs late (watches/plan.ts), booked through Go
// or on ixigo by themselves.
import type * as C from '@go/contract';
import type pg from 'pg';

export interface PersonPick {
  tripId: string;
  personId: string;
  kind: 'flight' | 'train' | 'bus';
  /** The way it goes, origin to destination by code or name ("DEL-GOX"): one pick per person per way. */
  way: string;
  optionId: string;
  title: string;
  journey: C.Journey | null;
  pickedAt: Date;
}

/** A pick's way: its journey's origin to destination, by code where it has one; one way for a ticket with no journey. */
export function wayOf(journey: C.Journey | null | undefined): string {
  if (!journey) return '-';
  const end = (p: { name: string; code?: string | null | undefined }): string => (p.code ?? p.name).trim().toUpperCase();
  return `${end(journey.origin)}-${end(journey.destination)}`.slice(0, 120);
}

export async function recordPick(pool: pg.Pool, p: PersonPick): Promise<void> {
  await pool.query(
    `insert into picks (trip_id, person_id, kind, way, option_id, title, journey, picked_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (trip_id, person_id, kind, way) do update set option_id = excluded.option_id, title = excluded.title,
       journey = excluded.journey, picked_at = excluded.picked_at`,
    [p.tripId, p.personId, p.kind, p.way, p.optionId, p.title, p.journey ? JSON.stringify(p.journey) : null, p.pickedAt],
  );
}

export async function picksOf(pool: pg.Pool, tripId: string): Promise<PersonPick[]> {
  const r = await pool.query<{ trip_id: string; person_id: string; kind: PersonPick['kind']; way: string; option_id: string; title: string; journey: C.Journey | null; picked_at: Date }>(
    `select trip_id, person_id, kind, way, option_id, title, journey, picked_at from picks where trip_id = $1 order by person_id, kind, way`,
    [tripId],
  );
  return r.rows.map((x) => ({ tripId: x.trip_id, personId: x.person_id, kind: x.kind, way: x.way, optionId: x.option_id, title: x.title, journey: x.journey, pickedAt: x.picked_at }));
}
