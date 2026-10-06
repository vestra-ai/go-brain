import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { nextOccurrence, tripToday } from '../dates.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
  await db.pool.query("insert into trips (trip_id, tz) values ('t_la', 'America/Los_Angeles'), ('t_goa_tz', 'Asia/Kolkata'), ('t_bad_tz', 'Not/AZone')");
});
afterAll(async () => {
  await db.drop();
});

describe("today in a trip's time zone", () => {
  it("reads the trip's zone, and India's for no trip, an unknown trip or a zone that is not one", async () => {
    // 03:00 UTC on 7 Oct: 8:30 am on 7 Oct in India, 8 pm on 6 Oct in Los Angeles.
    const today = tripToday(db.pool, () => new Date('2026-10-07T03:00:00Z'));
    expect(await today('t_la')).toBe('2026-10-06');
    expect(await today('t_goa_tz')).toBe('2026-10-07');
    expect(await today('t_bad_tz')).toBe('2026-10-07');
    expect(await today('t_nowhere')).toBe('2026-10-07');
    expect(await today(null)).toBe('2026-10-07');
  });

  it('names the same day this year while it is still ahead, else next year', () => {
    expect(nextOccurrence('2025-11-06', '2026-10-07')).toBe('2026-11-06');
    expect(nextOccurrence('2026-10-06', '2026-10-07')).toBe('2027-10-06');
    expect(nextOccurrence('2025-10-07', '2026-10-07')).toBe('2026-10-07');
  });
});
