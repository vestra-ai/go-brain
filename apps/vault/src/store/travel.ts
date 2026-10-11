import { z } from 'zod';
import { itemAad, openJson, sealJson } from '../crypto/envelope.js';
import type { Db } from './people.js';

/**
 * A person's travel details as on their ID, for a ticket Go books for them when the organizer's ixigo has no saved
 * traveller of theirs: given names and surname (ixigo's form asks for both), gender (as ixigo's form asks: male or
 * female) and date of birth. Sealed in the person's vault like a card (crypto/envelope.ts, the person and "travel" in its
 * AAD): no value of them is ever in a plaintext column, a log line or an error. A row kept is the person's yes to Go using
 * them for a ticket of their own; unticking or deleting removes the row itself.
 */
const Name = z.string().trim().min(1).max(40).regex(/^\p{L}[\p{L} '.-]*$/u);
/** An IRCTC user ID, for a train ticket (ixigo's passenger page asks for it): 3 to 35 letters, digits or underscores. */
const IrctcId = z.string().trim().regex(/^[A-Za-z0-9_]{3,35}$/);
export const TravelDetails = z.object({
  first_name: Name,
  last_name: Name,
  gender: z.enum(['male', 'female']),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Optional: only train tickets need it. Never the IRCTC password, which the vault never asks for or keeps. */
  irctc_user_id: IrctcId.nullish(),
});
export type TravelDetails = z.infer<typeof TravelDetails>;
/** The travel details by name, as an add_travel link names the ones a booking still needs. */
export const TRAVEL_FIELDS = ['first_name', 'last_name', 'gender', 'dob', 'irctc_user_id'] as const;
export type TravelField = (typeof TRAVEL_FIELDS)[number];

/** A date of birth that is a real day, today or before, at most 120 years back. */
export function realBirthday(dob: string, now: Date): boolean {
  const day = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== dob) return false;
  const today = now.toISOString().slice(0, 10);
  const oldest = `${Number(today.slice(0, 4)) - 120}${today.slice(4)}`;
  return dob <= today && dob >= oldest;
}

const aad = (personId: string) => itemAad(personId, 'travel', personId);

/** Keeps a person's details, sealed, replacing any before. Only these fields are sealed, whatever else `d` carries. */
export async function saveTravel(db: Db, master: Buffer, now: Date, personId: string, d: TravelDetails): Promise<void> {
  const details: TravelDetails = {
    first_name: d.first_name, last_name: d.last_name, gender: d.gender, dob: d.dob, ...(d.irctc_user_id ? { irctc_user_id: d.irctc_user_id } : {}),
  };
  await db.query(
    `insert into travel_details (person_id, sealed, created_at, updated_at) values ($1, $2, $3, $3)
     on conflict (person_id) do update set sealed = excluded.sealed, updated_at = excluded.updated_at`,
    [personId, sealJson(master, aad(personId), details), now],
  );
}

/** Removes a person's details, the row itself; whether there were any. */
export async function deleteTravel(db: Db, personId: string): Promise<boolean> {
  const r = await db.query('delete from travel_details where person_id = $1', [personId]);
  return (r.rowCount ?? 0) > 0;
}

/** A person's details, for their own page once unlocked; null when none are kept. */
export async function readOwnTravel(db: Db, master: Buffer, personId: string): Promise<TravelDetails | null> {
  const r = await db.query<{ sealed: Buffer }>('select sealed from travel_details where person_id = $1', [personId]);
  const row = r.rows[0];
  return row ? openJson<TravelDetails>(master, aad(personId), row.sealed) : null;
}

/**
 * A person's details for a ticket Go books for them: only when they are the traveller that booking is for (their own
 * ticket, never a group member's while booking someone else), and they kept details; null otherwise. The read is dated.
 */
export async function travelForBooking(
  db: Db, master: Buffer, now: Date, o: { personId: string; travellerPersonId: string },
): Promise<TravelDetails | null> {
  if (o.personId !== o.travellerPersonId) return null;
  const r = await db.query<{ sealed: Buffer }>('update travel_details set last_read_at = $2 where person_id = $1 returning sealed', [o.personId, now]);
  const row = r.rows[0];
  return row ? openJson<TravelDetails>(master, aad(o.personId), row.sealed) : null;
}
