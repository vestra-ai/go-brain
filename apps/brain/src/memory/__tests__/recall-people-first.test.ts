import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import type { Message } from '../../door/methods.js';
import { goaTrip, msg, packOf } from '../../reflex/goa.fixture.js';
import { recall, type RecallHit } from '../recall.js';
import { seedMessages } from './test-kit.js';

/**
 * The two recall misses of the definitive live run (bench-live 37467336781), with the run's own lines and numbers.
 * Go's lines are as the run reported them; where the report cut a line short, it ends where the report did. Lines that
 * match none of the questions' words fill each trip to its real size, so every word weighs what it weighed in the run.
 */
const filler = (from: number, n: number, who = 'p_kabir'): Message[] =>
  Array.from({ length: n }, (_, k) => msg(from + k, who, `filler line ${from + k}, nothing to see`));

const order = (hits: RecallHit[], seq: number): number => hits.findIndex((h) => h.seq === seq);

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => {
  db = await withSchema();
});
afterAll(async () => {
  await db.drop();
});

describe("goa-300: When is Meher's birthday?", () => {
  // Meher said it at #7. Go's own long messages that name her and her birthday outranked it.
  const said = msg(7, 'p_meher', "Also it's my birthday on the 7th so be ready 🎂");
  const go = [
    msg(11, 'go', "Not my department, Arjun 😄 Whoever has a good Bluetooth speaker, shout. Meher's birthday on the 7th means we'll"),
    msg(22, 'go', "Hey Rahul, quick catch-up: 6 to 9 Nov is still waiting on Priya, Arjun, Meher and Kabir to confirm it works. Everyone's food and travel notes are saved: Priya is veg, Meher can't have prawns, Kabir doesn't drink, Arjun needs flights after 9 am."),
    msg(23, 'go', 'Hey Arjun, quick catch-up: 6 to 9 Nov (Diwali weekend, 3 nights) is still waiting on your OK, plus Priya, Meher and Kabir.'),
    msg(240, 'go', 'Hey Meher, quick catch-up: 6 to 9 Nov (3 nights, your birthday on the 7th) is still waiting on a 👍 from you, Priya, Arjun and Kabir.'),
    msg(287, 'go', 'Hey Meher, quick catch-up: the villa vote is open (Casa Mareia, Villa Sol, The Palms Villa), 0 of 5 have voted,'),
  ];
  const people = [
    said,
    msg(120, 'p_priya', 'Meher DJ mat banna please'),
    msg(140, 'p_meher', 'Meher ka mood off hai kya?'),
    msg(160, 'p_meher', 'for my birthday on the 7th'),
    msg(230, 'p_kabir', "I'll go with whatever Meher decides"),
    msg(330, 'p_rahul', 'Meher ka mood off hai kya?'),
    msg(332, 'p_priya', 'Meher send the playlist'),
    msg(355, 'p_meher', 'Meher DJ mat banna please'),
    msg(370, 'p_meher', "I'll go with whatever Meher decides"),
    msg(376, 'p_arjun', 'Meher DJ mat banna please'),
    msg(379, 'p_meher', 'Meher you said that last time too 😂'),
  ];
  const taken = new Set([...people, ...go].map((m) => m.seq));
  const messages = [...people, ...go, ...filler(1, 380).filter((m) => !taken.has(m.seq))].sort((a, b) => a.seq - b.seq);
  const pack = packOf(messages, goaTrip({ trip_id: 't_live300' }));

  beforeAll(async () => {
    await seedMessages(db.pool, 't_live300', messages);
  });

  it("finds Meher's own line, and puts it above Go's messages that only repeat it", async () => {
    const hits = await recall(db.pool, pack, new Map(), "When is Meher's birthday?", 'group');
    expect(hits.some((h) => h.seq === 7 && h.text.includes('7th')), JSON.stringify(hits)).toBe(true);
    for (const g of [11, 240, 287]) {
      const at = order(hits, g);
      if (at >= 0) expect(order(hits, 7), JSON.stringify(hits)).toBeLessThan(at);
    }
  });
});

describe('goa-50: When can Arjun leave on Friday?', () => {
  // Arjun said it at #8. The asks that repeat the question's words, and Go's own answer, outranked it.
  const said = msg(8, 'p_arjun', "Office till 6 on Friday, can't leave before that 😩");
  const lines = [
    msg(5, 'p_kabir', 'bhai finally. leave bhi approve ho gayi'),
    said,
    msg(18, 'p_rahul', "@Go flights Delhi to Goa Friday evening? Arjun can't leave before 6"),
    msg(40, 'p_arjun', 'guys I just checked, Friday evening flights are filling up fast'),
    msg(97, 'p_rahul', "@Go what can't Meher eat, and when can Arjun leave on Friday?"),
    msg(98, 'go', "Meher is allergic to prawns, so no prawn dishes for her. Arjun can't leave before 6:30 pm on Friday, since his o"),
  ];
  const taken = new Set(lines.map((m) => m.seq));
  const messages = [...lines, ...filler(1, 100).filter((m) => !taken.has(m.seq))].sort((a, b) => a.seq - b.seq);
  const pack = packOf(messages, goaTrip({ trip_id: 't_live50' }));

  beforeAll(async () => {
    await seedMessages(db.pool, 't_live50', messages);
  });

  it("finds Arjun's own line first, above the asks that repeat the question and Go's answer", async () => {
    const hits = await recall(db.pool, pack, new Map(), 'When can Arjun leave on Friday?', 'group');
    expect(hits[0]?.seq, JSON.stringify(hits)).toBe(8);
    // Ranked down, not dropped: the ask and Go's answer still come back after it.
    expect(hits.map((h) => h.seq)).toEqual(expect.arrayContaining([97, 98]));
  });
});

describe("Go's own line as the only source", () => {
  const messages = [
    msg(1, 'p_rahul', 'Goa trip is happening!!'),
    msg(2, 'go', 'Your flight IndiGo 6E 2134 lands at 8:45 pm on Friday, Arjun.'),
    msg(3, 'p_kabir', 'haha 😂'),
    ...filler(4, 60),
  ];
  const pack = packOf(messages, goaTrip({ trip_id: 't_goonly' }));

  beforeAll(async () => {
    await seedMessages(db.pool, 't_goonly', messages);
  });

  it('is still found when nobody else said it', async () => {
    const hits = await recall(db.pool, pack, new Map(), 'When does the flight land?', 'group');
    expect(hits[0]?.seq, JSON.stringify(hits)).toBe(2);
  });
});
