import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import type { Message } from '../../door/methods.js';
import { goaTrip, msg, packOf } from '../../reflex/goa.fixture.js';
import { saveFact, type NewFact } from '../facts.js';
import { recall } from '../recall.js';
import { seedMessages } from './test-kit.js';

/**
 * The cases the live bench found on goa-300 (run 37442728267), with the message numbers it had: the notes pass, on a
 * real model, saved facts, and recall then let the person's other facts crowd out the answer, and showed a fact without
 * the words it came from.
 */
const KEY: Message[] = [
  msg(8, 'p_meher', "Also it's my birthday on the 7th so be ready 🎂"),
  msg(20, 'p_meher', "and I'm allergic to prawns. Not fun last time 😅"),
  // Edited in the chat from "window seat for me pls 🙏".
  msg(23, 'p_priya', 'aisle seat for me pls 🙏 changed my mind'),
  msg(26, 'p_arjun', "no flights before 9 am for me, I can't do early flights"),
  msg(95, 'p_priya', 'edited my seat thing, aisle is better for me'),
  msg(183, 'p_meher', 'for my birthday on the 7th'),
  msg(454, 'p_meher', 'should we rent a scooty for the trip?'),
  msg(496, 'p_meher', 'someone pack sunscreen for me'),
  msg(500, 'p_meher', 'bring helmets guys'),
];
const FILLER: Array<[string, string]> = [
  ['p_kabir', 'Meher you said that last time too 😂'],
  ['p_rahul', 'Arjun send the playlist'],
  ['p_priya', 'I want kokum juice at least once'],
  ['p_arjun', 'I want xacuti at least once'],
  ['p_meher', 'lol same'],
];
const messages: Message[] = [...KEY];
let seq = 600;
for (let round = 0; round < 20; round += 1) for (const [who, text] of FILLER) messages.push(msg((seq += 1), who, text));
const pack = packOf(messages, goaTrip({ trip_id: 't_live' }));
const at = (day: number): Date => new Date(Date.UTC(2026, 9, day, 10));
const fact = (personId: string, topic: string, text: string, msgSeq: number, day: number): NewFact => ({
  personId, tripId: 't_live', topic, text, messageId: `m_${String(msgSeq).padStart(4, '0')}`, saidAt: at(day), audience: 'group', source: 'message',
});

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => {
  db = await withSchema();
  await seedMessages(db.pool, 't_live', messages);
  // Meher's other facts, none about food.
  await saveFact(db.pool, fact('p_meher', 'scooter', 'Asking about renting scooty for the trip', 454, 3));
  await saveFact(db.pool, fact('p_meher', 'health', 'Needs sunscreen', 496, 3));
  await saveFact(db.pool, fact('p_meher', 'activities', 'Bring helmet', 500, 3));
  // Her birthday was said twice; the newer fact replaced the older one.
  await saveFact(db.pool, fact('p_meher', 'birthday', 'Birthday on the 7th', 8, 1));
  await saveFact(db.pool, fact('p_meher', 'birthday', 'Birthday on 7 Nov, wants cake from bakery near Anjuna', 183, 2));
  await saveFact(db.pool, fact('p_arjun', 'flights', 'No flights before 9 am', 26, 1));
  await saveFact(db.pool, fact('p_priya', 'seats', 'Aisle seat', 95, 1));
});
afterAll(async () => { await db.drop(); });

describe('recall with facts, the live bench\'s cases', () => {
  it('"What is Meher allergic to?": the message that answers comes first, and at most two of her other facts come along', async () => {
    const hits = await recall(db.pool, pack, new Map(), 'What is Meher allergic to?', 'group');
    expect(hits[0], JSON.stringify(hits)).toMatchObject({ seq: 20, text: "Meher: and I'm allergic to prawns. Not fun last time 😅" });
    expect(hits.filter((h) => h.text.startsWith('Meher (')).length, JSON.stringify(hits)).toBeLessThanOrEqual(2);
  });

  it('"Who can\'t take early flights?": the fact comes with the words and number of the message it was said in', async () => {
    const hits = await recall(db.pool, pack, new Map(), "Who can't take early flights?", 'group');
    expect(hits[0], JSON.stringify(hits)).toEqual({
      text: "Arjun (flights): No flights before 9 am (#26 Arjun: no flights before 9 am for me, I can't do early flights)",
      messageId: 'm_0026',
      seq: 26,
    });
  });

  it('"Which seat does Priya want?": both her edited line and the later fact\'s message, each with its own number', async () => {
    const hits = await recall(db.pool, pack, new Map(), 'Which seat does Priya want?', 'group');
    expect(hits.slice(0, 2).map((h) => h.seq).sort((a, b) => a - b), JSON.stringify(hits)).toEqual([23, 95]);
    expect(hits.find((h) => h.seq === 95)?.text).toBe('Priya (seats): Aisle seat (#95 Priya: edited my seat thing, aisle is better for me)');
    expect(hits.find((h) => h.seq === 23)?.text).toBe('Priya: aisle seat for me pls 🙏 changed my mind');
  });

  it('"When is Meher\'s birthday?": the newer fact names the message it came from and the earlier one on its topic, and that line comes back too', async () => {
    const hits = await recall(db.pool, pack, new Map(), "When is Meher's birthday?", 'group');
    expect(hits.find((h) => h.seq === 183)?.text, JSON.stringify(hits)).toBe(
      'Meher (birthday): Birthday on 7 Nov, wants cake from bakery near Anjuna (#183 Meher: for my birthday on the 7th; earlier on this topic: #8)',
    );
    expect(hits.find((h) => h.seq === 8)?.text, JSON.stringify(hits)).toBe("Meher: Also it's my birthday on the 7th so be ready 🎂");
  });

  it('a forgotten person\'s fact never comes back, nor an earlier message of theirs in another fact\'s proof', async () => {
    const forgotten = new Map([['p_meher', 1_000]]);
    const hits = await recall(db.pool, pack, forgotten, "When is Meher's birthday?", 'group');
    expect(hits.some((h) => h.text.includes('Meher (') || h.text.startsWith('Meher:')), JSON.stringify(hits)).toBe(false);
  });
});
