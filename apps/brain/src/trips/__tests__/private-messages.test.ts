import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeLink } from '../../__tests__/fixtures/fake-link.js';
import { ev, goaSnapshot, msg } from '../../__tests__/fixtures/goa.js';
import { createContext } from '../../composer/context.js';
import { renderMessageWake } from '../../composer/wakes.js';
import { withSchema } from '../../db/test-db.js';
import { silentLog } from '../../log.js';
import { upsertMessage } from '../apply.js';
import { createPacks, type TripPack } from '../pack.js';
import { isPrivate, screenMessage } from '../screen.js';

// Keshav, 10 Oct: Go can post a message only some people see (contract 1.2, visible_to_person_ids): a traveller's own
// flight options, their booking's steps, an owner's note. Go keeps none of its words, and no turn ever reads it, so no
// reply, recall or summary can repeat it to the room or to anyone it isn't for.
let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

const SECRET = 'Ready to pay ₹7,536 for Meher: IndiGo 6E2150';
const card = { card_id: 'c_ready_1', kind: 'notice', tone: 'info', title: SECRET, body: 'SALE coupon: ₹360 off.', fallback_text: SECRET, for_person_ids: ['p_meher'] };
const mine = (seq: number) => msg(seq, null, SECRET, { visible_to_person_ids: ['p_meher'], card: card as never });

describe('a message only some people see', () => {
  it('keeps none of its words past the door: no text, card, attachment or quick reply, only that it was posted', () => {
    const m = mine(5);
    const s = screenMessage(m);
    expect(isPrivate(m)).toBe(true);
    expect(s).toEqual({ ...m, text: null, card: null, attachments: [], quick_replies: null });
    expect(JSON.stringify(s)).not.toContain('6E2150');
    // One everyone sees is screened as ever.
    expect(isPrivate(msg(6, 'p_priya', 'hi'))).toBe(false);
  });

  it("is never in the trip's pack, from read_messages, an event or the messages table, and keeps no words there", async () => {
    const T = 't_private';
    const f = fakeLink({
      read_trip: () => goaSnapshot({ trip_id: T, seq: 4 }),
      read_messages: () => ({ messages: [msg(2, 'p_priya', 'flights kab dekhenge?'), mine(3)], has_more: false }),
    });
    const packs = createPacks({ pool: db.pool, link: f.link, log: silentLog, now: () => new Date() });
    const pack = await packs.get(T);
    expect(pack.messages.map((m) => m.seq)).toEqual([2]);
    await packs.apply(ev(4, 'message.created', { message: screenMessage(mine(4)) }, T));
    expect(pack.messages.map((m) => m.seq)).toEqual([2]);
    const { rows } = await db.pool.query<{ seq: number; text: string | null; payload: unknown }>('select seq, text, payload from messages where trip_id = $1 order by seq', [T]);
    expect(rows.map((r) => [r.seq, r.text])).toEqual([[2, 'flights kab dekhenge?'], [3, null], [4, null]]);
    expect(JSON.stringify(rows)).not.toContain('6E2150');
    // Loaded fresh from the table, it stays out.
    packs.invalidate(T);
    expect((await packs.get(T)).messages.map((m) => m.seq)).toEqual([2]);
  });

  it("the composer's chat never holds it, so no reply repeats it to the room or to anyone it isn't for", async () => {
    const pack: TripPack = { trip: goaSnapshot(), messages: [], seq: 10 };
    for (const m of [msg(2, 'p_rahul', 'sab ki flights dekh lo'), mine(3), msg(4, 'p_kabir', '@Go how much is Meher paying?')]) upsertMessage(pack, screenMessage(m));
    const c = createContext(silentLog);
    c.addWake('message', renderMessageWake);
    const built = await c.build({
      tripId: 't_goa', pack, seenSeq: 0, now: new Date('2026-10-10T09:00:00Z'), tz: 'Asia/Kolkata',
      wake: [{ id: 'w1', tripId: 't_goa', kind: 'message', ref: 'm_4', dueAt: new Date(), payload: { messageId: 'm_4', namesGo: true } }],
    });
    const prompt = JSON.stringify(built);
    expect(prompt).toContain('how much is Meher paying');
    expect(prompt).not.toContain('7,536');
    expect(prompt).not.toContain('6E2150');
  });
});
