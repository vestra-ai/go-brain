import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../../db/test-db.js';
import { msg } from '../../../__tests__/fixtures/goa.js';
import { goaPack } from '../../../tasks/testing/goa.js';
import type { DeskItem } from '../../../desk/desk.js';
import { BOOKING_NOW_MS, bookingsNow } from '../booking-now.js';

let db: Awaited<ReturnType<typeof withSchema>>;
const NOW = new Date('2026-10-11T08:29:10Z');

beforeAll(async () => {
  db = await withSchema();
});
afterAll(async () => {
  await db.drop();
});

/** A booking row as Go keeps it, `minutes` before now. */
async function booked(tripId: string, runId: string, personId: string, state: string, why: string | null, minutes: number, totalMinor: number | null = null) {
  const at = new Date(NOW.getTime() - minutes * 60_000);
  await db.pool.query(
    `insert into flight_bookings (run_id, trip_id, person_id, option_id, title, choice, state, why, total_minor, created_at, updated_at)
     values ($1, $2, $3, 'opt_1', 'IndiGo 6E2150', 'basic', $4, $5, $6, $7, $7)`,
    [runId, tripId, personId, state, why, totalMinor, at],
  );
}

/** The block for a turn of the trip woken by these people's messages (none: a turn Go woke for itself). */
function render(tripId: string, ...speakers: string[]) {
  const messages = speakers.map((p, i) => msg(90 + i, p, '?'));
  const pack = { ...goaPack(), messages: [...goaPack().messages, ...messages] };
  // A full name in the trip: Go says the first.
  pack.trip = { ...pack.trip, people: pack.trip.people.map((p) => (p.person_id === 'p_meher' ? { ...p, name: 'Meher Kapoor' } : p)) };
  const wake: DeskItem[] = messages.map((m) => ({
    id: `msg:${tripId}:${m.message_id}`, tripId, kind: 'message', ref: m.message_id, dueAt: NOW, payload: { messageId: m.message_id, seq: m.seq },
  }));
  return bookingsNow({ pool: db.pool, packs: { get: async () => pack }, now: () => NOW }).render(tripId, wake);
}

const lines = (block: string | null) => block!.split('\n').slice(1);

// The lead, 11 Oct: Ankur's "?" right after his booking stopped got "what do you need?", the composer knowing nothing;
// p2's prod audit #16: the group's turns never knew a booking step was up, its posts being for one person.
describe("the trip's flight bookings, right now", () => {
  it("says each traveller's latest booking, why it stopped and what they can do, by first name, never that Go cannot book", async () => {
    await booked('t_bn1', 'fb_m1', 'p_meher', 'failed', 'fare_moved', 2, 753_600);
    await booked('t_bn1', 'fb_m2', 'p_meher', 'failed', 'travellers_not_read', 1);
    const block = await render('t_bn1', 'p_meher');
    // Hers, latest only, marked as the one who spoke.
    expect(lines(block)).toEqual([
      "- Meher (spoke now): IndiGo 6E2150 stopped (1 min ago): Go couldn't read their saved travellers on ixigo; their card is back: I'll take this tries again.",
    ]);
    expect(block).toContain("never that Go can't book flights");
    expect(block).toContain("bring up nobody's unasked");
  });

  it('is in every turn of the trip, whoever spoke first, and in a turn nobody woke too', async () => {
    await booked('t_bn2', 'fb_k1', 'p_kabir', 'ready_to_pay', null, 3, 789_600);
    await booked('t_bn2', 'fb_a1', 'p_arjun', 'fare_type', null, 0.5);
    await booked('t_bn2', 'fb_r1', 'p_rahul', 'failed', 'login_needed', 4);
    const all = [
      "- Arjun: Go is booking IndiGo 6E2150 for them on the trip's computer now; their pay card comes when it's ready.",
      '- Kabir: IndiGo 6E2150: their pay card is up, ₹7,896 (3 min ago); Pay with ixigo money on it pays.',
      "- Rahul: IndiGo 6E2150 waits for the trip's ixigo login (since 4 min ago): Go carries on by itself once it's in.",
    ];
    // Priya has none: the group's turn knows the others' all the same.
    expect(lines(await render('t_bn2', 'p_priya')).sort()).toEqual(all);
    expect(lines(await render('t_bn2')).sort()).toEqual(all);
    // Rahul spoke: his first.
    expect(lines(await render('t_bn2', 'p_rahul'))[0]).toBe("- Rahul (spoke now): IndiGo 6E2150 waits for the trip's ixigo login (since 4 min ago): Go carries on by itself once it's in.");
  });

  it('leaves out a booking that has not moved for hours, and says one cut off mid-run can be tapped again', async () => {
    await booked('t_bn3', 'fb_p1', 'p_priya', 'failed', 'fare_not_found', BOOKING_NOW_MS / 60_000 + 5);
    expect(await render('t_bn3', 'p_priya')).toBeNull();
    await booked('t_bn3', 'fb_p2', 'p_priya', 'travellers', null, 10);
    expect(lines(await render('t_bn3', 'p_priya'))).toEqual(["- Priya (spoke now): Go's booking of IndiGo 6E2150 was cut off (10 min ago); their card is back: I'll take this tries again."]);
  });
});
