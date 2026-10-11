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
async function booked(runId: string, personId: string, state: string, why: string | null, minutes: number, totalMinor: number | null = null) {
  const at = new Date(NOW.getTime() - minutes * 60_000);
  await db.pool.query(
    `insert into flight_bookings (run_id, trip_id, person_id, option_id, title, choice, state, why, total_minor, created_at, updated_at)
     values ($1, 't_goa', $2, 'opt_1', 'IndiGo 6E2150', 'basic', $3, $4, $5, $6, $6)`,
    [runId, personId, state, why, totalMinor, at],
  );
}

/** The block for a turn woken by these people's messages. */
function render(...speakers: string[]) {
  const messages = speakers.map((p, i) => msg(90 + i, p, '?'));
  const pack = { ...goaPack(), messages: [...goaPack().messages, ...messages] };
  const wake: DeskItem[] = messages.map((m) => ({
    id: `msg:t_goa:${m.message_id}`, tripId: 't_goa', kind: 'message', ref: m.message_id, dueAt: NOW, payload: { messageId: m.message_id, seq: m.seq },
  }));
  return bookingsNow({ pool: db.pool, packs: { get: async () => pack }, now: () => NOW }).render('t_goa', wake);
}

// The lead, 11 Oct: Ankur's "?" right after his booking stopped got "what do you need?", the composer knowing nothing.
describe("a person's own flight booking in the turns they speak in", () => {
  it('says where the speaker\'s latest booking is, why it stopped, and what they can do, never that Go cannot book', async () => {
    await booked('fb_m1', 'p_meher', 'failed', 'fare_moved', 2, 753_600);
    await booked('fb_m2', 'p_meher', 'failed', 'travellers_not_read', 1);
    const block = (await render('p_meher'))!;
    // Her latest only.
    expect(block.split('\n').slice(1)).toEqual([
      "- Meher: IndiGo 6E2150 stopped (1 min ago): Go couldn't read their saved travellers on ixigo; their card is back: I'll take this tries again.",
    ]);
    expect(block).toContain("never that Go can't book flights");
  });

  it('is said for each person who spoke, and only them', async () => {
    await booked('fb_k1', 'p_kabir', 'ready_to_pay', null, 3, 789_600);
    await booked('fb_a1', 'p_arjun', 'fare_type', null, 0.5);
    await booked('fb_r1', 'p_rahul', 'failed', 'login_needed', 4);
    const block = (await render('p_kabir', 'p_arjun', 'p_rahul'))!;
    expect(block.split('\n').slice(1).sort()).toEqual([
      "- Arjun: Go is booking IndiGo 6E2150 for them on the trip's computer now; their pay card comes when it's ready.",
      '- Kabir: IndiGo 6E2150: their pay card is up, ₹7,896 (3 min ago); Pay on it pays.',
      "- Rahul: IndiGo 6E2150 waits for the trip's ixigo login (since 4 min ago): Go carries on by itself once it's in.",
    ]);
    // Priya spoke and has none; Meher has one but didn't speak.
    expect(await render('p_priya')).toBeNull();
    expect(await render('p_kabir')).not.toContain('Meher');
  });

  it('leaves out a booking that has not moved for hours, and says one cut off mid-run can be tapped again', async () => {
    await booked('fb_p1', 'p_priya', 'failed', 'fare_not_found', BOOKING_NOW_MS / 60_000 + 5);
    expect(await render('p_priya')).toBeNull();
    await booked('fb_p2', 'p_priya', 'travellers', null, 10);
    expect(await render('p_priya')).toContain("Priya: Go's booking of IndiGo 6E2150 was cut off (10 min ago); their card is back: I'll take this tries again.");
  });

  it('says nothing for a turn no person woke', async () => {
    const block = await bookingsNow({ pool: db.pool, packs: { get: async () => goaPack() }, now: () => NOW }).render('t_goa', []);
    expect(block).toBeNull();
  });
});
