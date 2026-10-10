import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withVaultSchema } from '../db/test-db.js';
import { ensurePerson } from './people.js';
import { TravelDetails, deleteTravel, readOwnTravel, realBirthday, saveTravel, travelForBooking } from './travel.js';

const now = new Date('2026-10-10T09:00:00Z');
const master = randomBytes(32);
const MEHER: TravelDetails = { first_name: 'Meher', last_name: 'Kapoor', gender: 'female', dob: '1996-03-14' };
let pool: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ pool, drop } = await withVaultSchema());
  await ensurePerson(pool, 'p_meher', now, 'Meher');
  await ensurePerson(pool, 'p_rahul', now, 'Rahul');
});
afterAll(async () => {
  await drop();
});

describe("a person's travel details", () => {
  it('are kept sealed: no value of them is in the row, and they open only as their own', async () => {
    await saveTravel(pool, master, now, 'p_meher', MEHER);
    const row = (await pool.query('select * from travel_details where person_id = $1', ['p_meher'])).rows[0] as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toMatch(/Meher|Kapoor|female|1996/);
    expect(Buffer.from(row['sealed'] as Buffer).toString('latin1')).not.toMatch(/Kapoor|1996-03-14/);
    expect(await readOwnTravel(pool, master, 'p_meher')).toEqual(MEHER);
    // A row copied to another person never opens.
    await pool.query('insert into travel_details (person_id, sealed, created_at, updated_at) values ($1, $2, $3, $3)', ['p_rahul', row['sealed'], now]);
    await expect(readOwnTravel(pool, master, 'p_rahul')).rejects.toThrow();
    await deleteTravel(pool, 'p_rahul');
  });

  it("are read for a booking only when the person is that booking's traveller, and the read is dated", async () => {
    expect(await travelForBooking(pool, master, now, { personId: 'p_meher', travellerPersonId: 'p_rahul' })).toBeNull();
    const later = new Date(now.getTime() + 60_000);
    expect(await travelForBooking(pool, master, later, { personId: 'p_meher', travellerPersonId: 'p_meher' })).toEqual(MEHER);
    const row = (await pool.query('select last_read_at from travel_details where person_id = $1', ['p_meher'])).rows[0] as { last_read_at: Date };
    expect(row.last_read_at.toISOString()).toBe(later.toISOString());
    expect(await travelForBooking(pool, master, later, { personId: 'p_rahul', travellerPersonId: 'p_rahul' })).toBeNull();
  });

  it('are replaced when saved again, and deleting removes the row itself', async () => {
    await saveTravel(pool, master, now, 'p_meher', { ...MEHER, last_name: 'Kapoor Shah' });
    expect((await readOwnTravel(pool, master, 'p_meher'))?.last_name).toBe('Kapoor Shah');
    expect(await deleteTravel(pool, 'p_meher')).toBe(true);
    expect((await pool.query('select count(*)::int as n from travel_details where person_id = $1', ['p_meher'])).rows[0]).toEqual({ n: 0 });
    expect(await deleteTravel(pool, 'p_meher')).toBe(false);
  });

  it('take a name as on an ID and a real date of birth', () => {
    expect(TravelDetails.safeParse(MEHER).success).toBe(true);
    expect(TravelDetails.safeParse({ ...MEHER, first_name: 'Anne-Marie', last_name: "D'Souza" }).success).toBe(true);
    for (const bad of [{ first_name: '' }, { first_name: '<script>' }, { last_name: 'x'.repeat(41) }, { gender: 'other' }, { dob: '14/03/1996' }]) {
      expect(TravelDetails.safeParse({ ...MEHER, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(realBirthday('1996-03-14', now)).toBe(true);
    expect(realBirthday('1996-02-30', now)).toBe(false);
    expect(realBirthday('2027-01-01', now)).toBe(false);
    expect(realBirthday('1900-01-01', now)).toBe(false);
  });
});
