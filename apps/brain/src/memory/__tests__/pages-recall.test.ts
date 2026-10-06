import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { goaTrip, msg, packOf } from '../../reflex/goa.fixture.js';
import { saveFact, setCarryOver, type NewFact } from '../facts.js';
import { drawPage } from '../pages.js';
import { queryWords, recall } from '../recall.js';
import { seedMessages } from './test-kit.js';

let db: { pool: Pool; drop: () => Promise<void> };
const goa = [
  msg(101, 'p_meher', "I'm allergic to peanuts, so no satay for me"),
  msg(102, 'p_priya', 'veg khaana chahiye har jagah'),
  msg(103, 'p_kabir', 'I get seasick on boats'),
  msg(104, 'p_arjun', 'my passport number is in the drive', { deleted: true }),
  msg(105, 'p_rahul', 'Paid the villa deposit, send me your share on UPI'),
  msg(106, 'go', 'Noted, thanks Rahul.'),
];
const manali = [msg(201, 'p_meher', 'Peanuts are fine for me in Manali')];
const pack = packOf(goa.filter((m) => !m.deleted), goaTrip());
const fact = (over: Partial<NewFact>): NewFact => ({
  personId: 'p_meher', tripId: 't_goa', topic: 'food', text: 'Allergic to peanuts', messageId: 'm_0101',
  saidAt: new Date('2026-10-05T05:41:00Z'), audience: 'group', source: 'message', ...over,
});

beforeAll(async () => {
  db = await withSchema();
  await seedMessages(db.pool, 't_goa', goa);
  await seedMessages(db.pool, 't_manali', manali);
  await saveFact(db.pool, fact({}));
  await saveFact(db.pool, fact({ topic: 'drinks', text: "Doesn't drink", messageId: null, source: 'join' }));
  await saveFact(db.pool, fact({ topic: 'health', text: 'Carries an inhaler', audience: 'go' }));
  // Manali is the newer trip: its food fact is newer than Goa's, and Goa's page must still show Goa's.
  await saveFact(db.pool, fact({ tripId: 't_manali', text: 'Eats everything', messageId: 'm_0201', saidAt: new Date('2026-12-01T05:00:00Z') }));
  await saveFact(db.pool, fact({ tripId: 't_manali', topic: 'boats', text: 'Fine on boats', messageId: 'm_0201', saidAt: new Date('2026-12-01T05:00:00Z') }));
});
afterAll(async () => { await db.drop(); });

describe('drawPage', () => {
  it('draws one line per fact with its proof, this trip only while carry-over is off', async () => {
    const page = await drawPage(db.pool, 't_goa', 'p_meher', 'go');
    expect(page.split('\n').sort()).toEqual([
      "- drinks: Doesn't drink (join answer)",
      '- food: Allergic to peanuts (#101)',
      '- health: Carries an inhaler (#101) [only for Go]',
    ]);
  });

  it('leaves out facts only Go may see when drawn for the group', async () => {
    expect(await drawPage(db.pool, 't_goa', 'p_meher', 'group')).not.toContain('inhaler');
  });

  it('fills topics from earlier trips with carry-over on, and this trip still wins its own topics', async () => {
    await setCarryOver(db.pool, 'p_meher', true);
    const page = await drawPage(db.pool, 't_goa', 'p_meher', 'group');
    expect(page).toContain('- boats: Fine on boats (earlier trip)');
    expect(page).toContain('- food: Allergic to peanuts (#101)');
    expect(page).not.toContain('Eats everything');
    await setCarryOver(db.pool, 'p_meher', false);
  });

  it('takes the newest fact on a topic when two other trips disagree, and only with carry-over on', async () => {
    expect(await drawPage(db.pool, 't_kerala', 'p_meher', 'group')).toBe('');
    await setCarryOver(db.pool, 'p_meher', true);
    const page = await drawPage(db.pool, 't_kerala', 'p_meher', 'group');
    expect(page.split('\n').filter((l) => l.startsWith('- food:'))).toEqual(['- food: Eats everything (earlier trip)']);
    await setCarryOver(db.pool, 'p_meher', false);
  });

  it('is empty for someone Go knows nothing about', async () => {
    expect(await drawPage(db.pool, 't_goa', 'p_nobody', 'go')).toBe('');
  });
});

describe('recall', () => {
  it('answers "what can\'t Meher eat" from her fact, with the words and number of the message it came from', async () => {
    const hits = await recall(db.pool, pack, new Map(), "what can't Meher eat?", 'go');
    expect(hits[0]).toEqual({
      text: "Meher (food): Allergic to peanuts (#101 Meher: I'm allergic to peanuts, so no satay for me)",
      messageId: 'm_0101',
      seq: 101,
    });
  });

  it('finds a romanised Hindi spelling it was not given exactly', async () => {
    // "khana" is not a word in the chat ("khaana" is), so only the trigram match can find it.
    const hits = await recall(db.pool, pack, new Map(), 'khana', 'go');
    expect(hits.map((h) => h.messageId)).toContain('m_0102');
  });

  it('finds who paid', async () => {
    const hits = await recall(db.pool, pack, new Map(), 'who paid the deposit on UPI?', 'go');
    expect(hits[0]).toMatchObject({ messageId: 'm_0105', seq: 105, text: 'Rahul: Paid the villa deposit, send me your share on UPI' });
  });

  it('never returns a deleted message, another trip\'s chat, or a forgotten person\'s old words', async () => {
    expect(await recall(db.pool, pack, new Map(), 'passport number', 'go')).toEqual([]);
    expect((await recall(db.pool, pack, new Map(), 'peanuts Manali', 'go')).map((h) => h.messageId)).not.toContain('m_0201');
    const forgotten = new Map([['p_kabir', 150]]);
    expect((await recall(db.pool, pack, forgotten, 'seasick boats', 'go')).map((h) => h.messageId)).not.toContain('m_0103');
  });

  it('leaves out facts only Go may see when asked for the group', async () => {
    const hits = await recall(db.pool, pack, new Map(), 'inhaler', 'group');
    expect(hits.some((h) => h.text.includes('inhaler'))).toBe(false);
  });

  it('turns a question into search words, Hinglish stop words out, food words in', () => {
    expect(queryWords('Meher kya khana nahi khati?')).toEqual(['meher', 'khana', 'khati']);
    expect(queryWords("what can't Meher eat")).toEqual(['meher', 'eat', 'food', 'veg', 'vegetarian', 'vegan', 'allergic', 'allergy', 'khana']);
    expect(queryWords('what is the')).toEqual([]);
  });
});
