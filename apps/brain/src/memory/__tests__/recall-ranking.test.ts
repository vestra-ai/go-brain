import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import type { Message } from '../../door/methods.js';
import { goaTrip, msg, packOf } from '../../reflex/goa.fixture.js';
import { RECALL_MAX, recall } from '../recall.js';
import { seedMessages } from './test-kit.js';

/**
 * A long chat like the bench's goa-2000: the few lines that matter, buried in hundreds of repeated filler lines
 * that share common words with the questions ("I want ...", "Meher you said that ...", "bro the veg thali ...").
 */
const KEY: Array<[string, string]> = [
  ['p_meher', 'my birthday is on the 7th, just saying 🎂'],
  ['p_priya', "I'm veg btw"],
  ['p_meher', 'allergic to prawns, so no prawn anything for me'],
  ['p_arjun', 'no flights before 10 am for me please, changed my mind'],
  ['p_kabir', 'I get seasick, so no boat trips for me'],
  ['p_kabir', "and I don't drink, so keep me out of the bar bill"],
  ['p_priya', "I'm scared of scooters, I'll take cabs everywhere"],
  ['p_rahul', "Who's paying the villa advance? I can put it on my card"],
  ['p_meher', 'yes Rahul pays the advance, we UPI him'],
];
const FILLER: Array<[string, string]> = [
  ['p_arjun', 'I want xacuti at least once'],
  ['p_kabir', 'Meher you said that last time too 😂'],
  ['p_rahul', 'Arjun send the playlist'],
  ['p_meher', 'bro the veg thali at that shack in Baga 🤤'],
  ['p_priya', 'I want kokum juice at least once'],
  ['p_arjun', 'ok go, flights Bangalore to Goa Friday after 7 pm?'],
  ['p_meher', 'birthday cake inspo'],
  ['p_rahul', '@Go put the villa options to a vote'],
  ['p_kabir', 'I can drive the scooty, Meher sits behind 😂'],
  ['p_priya', '@Go veg thalis in Panjim?'],
];

const messages: Message[] = [];
let seq = 0;
for (const [who, text] of KEY) messages.push(msg((seq += 1), who, text));
for (let round = 0; round < 60; round += 1) for (const [who, text] of FILLER) messages.push(msg((seq += 1), who, text));
const pack = packOf(messages, goaTrip());
const seqOf = (text: string): number => messages.find((m) => m.text === text)!.seq;

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => {
  db = await withSchema();
  await seedMessages(db.pool, 't_goa', messages);
});
afterAll(async () => { await db.drop(); });

describe('recall in a long chat', () => {
  const probes: Array<[string, string, string]> = [
    ['What is Meher allergic to?', 'prawn', 'allergic to prawns, so no prawn anything for me'],
    ['Who gets seasick?', 'seasick', 'I get seasick, so no boat trips for me'],
    ["Who doesn't want to ride a scooter?", 'scooter', "I'm scared of scooters, I'll take cabs everywhere"],
    ["Who said they're veg?", 'veg', "I'm veg btw"],
    ["Who doesn't drink?", 'drink', "and I don't drink, so keep me out of the bar bill"],
    ["What is too early for Arjun's flights?", '10 am', 'no flights before 10 am for me please, changed my mind'],
    ["When is Meher's birthday?", '7th', 'my birthday is on the 7th, just saying 🎂'],
    ['Who is paying the villa advance?', 'Rahul pays', 'yes Rahul pays the advance, we UPI him'],
  ];
  for (const [question, answer, line] of probes) {
    it(`finds the line for "${question}" among ${messages.length} messages`, async () => {
      const started = Date.now();
      const hits = await recall(db.pool, pack, new Map(), question, 'group');
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(hits.length).toBeLessThanOrEqual(RECALL_MAX);
      expect(hits.some((h) => h.seq === seqOf(line) && h.text.toLowerCase().includes(answer.toLowerCase())), JSON.stringify(hits)).toBe(true);
    });
  }

  it('stems: "paying" finds "pays", so the answer and the question that asked it come first', async () => {
    const hits = await recall(db.pool, pack, new Map(), 'Who is paying the villa advance?', 'group');
    expect(hits.slice(0, 2).map((h) => h.seq).sort((a, b) => a - b)).toEqual([seqOf(KEY[7]![1]), seqOf(KEY[8]![1])]);
  });
});
