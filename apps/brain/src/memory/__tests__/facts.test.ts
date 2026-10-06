import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import {
  countFacts, currentFacts, deleteFactChain, dropFactsFromMessage, forgetFacts, forgottenUpTo, getCarryOver,
  markForgotten, normTopic, saveFact, setCarryOver, type NewFact,
} from '../facts.js';

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => { db = await withSchema(); });
afterAll(async () => { await db.drop(); });

const fact = (over: Partial<NewFact>): NewFact => ({
  personId: 'p_meher', tripId: 't_goa', topic: 'food', text: 'Vegetarian', messageId: 'm_0101',
  saidAt: new Date('2026-10-05T05:00:00Z'), audience: 'group', source: 'message', ...over,
});
const allRows = async (personId: string) =>
  (await db.pool.query('SELECT fact_id, text, superseded_by FROM facts WHERE person_id = $1 ORDER BY created_at', [personId])).rows;

describe('saveFact', () => {
  it('keeps one current fact per person, topic and trip, with history underneath', async () => {
    const a = await saveFact(db.pool, fact({ personId: 'p_a', text: 'Vegetarian' }));
    const again = await saveFact(db.pool, fact({ personId: 'p_a', text: 'vegetarian ', messageId: 'm_0109' }));
    expect(again).toEqual({ factId: a.factId, changed: false });
    const b = await saveFact(db.pool, fact({ personId: 'p_a', text: 'Eats fish now', messageId: 'm_0150' }));
    expect(b.changed).toBe(true);
    expect((await currentFacts(db.pool, { personId: 'p_a' })).map((f) => f.text)).toEqual(['Eats fish now']);
    const rows = await allRows('p_a');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ fact_id: a.factId, superseded_by: b.factId });
  });

  it('keeps each trip\'s fact on the same topic apart', async () => {
    await saveFact(db.pool, fact({ personId: 'p_b', tripId: 't_goa', text: 'Vegetarian' }));
    await saveFact(db.pool, fact({ personId: 'p_b', tripId: 't_manali', text: 'Eats chicken' }));
    expect((await currentFacts(db.pool, { personId: 'p_b' })).map((f) => f.tripId).sort()).toEqual(['t_goa', 't_manali']);
    expect((await currentFacts(db.pool, { personId: 'p_b', tripId: 't_goa' })).map((f) => f.text)).toEqual(['Vegetarian']);
  });

  it('cleans the topic into a short key', () => {
    expect(normTopic('Food & Drinks!!')).toBe('food_drinks');
    expect(normTopic('   ')).toBe('other');
    expect(normTopic('x'.repeat(60))).toHaveLength(40);
  });
});

describe('dropFactsFromMessage', () => {
  it('drops the facts a deleted message gave, and the older fact takes its place again', async () => {
    await saveFact(db.pool, fact({ personId: 'p_c', text: 'Vegetarian', messageId: 'm_0201' }));
    await saveFact(db.pool, fact({ personId: 'p_c', text: 'Eats fish now', messageId: 'm_0202' }));
    expect(await dropFactsFromMessage(db.pool, 't_goa', 'm_0202')).toBe(1);
    expect((await currentFacts(db.pool, { personId: 'p_c' })).map((f) => f.text)).toEqual(['Vegetarian']);
  });

  it('removes a history row from the middle of a chain and keeps the chain whole', async () => {
    await saveFact(db.pool, fact({ personId: 'p_d', text: 'One', messageId: 'm_0301' }));
    await saveFact(db.pool, fact({ personId: 'p_d', text: 'Two', messageId: 'm_0302' }));
    const three = await saveFact(db.pool, fact({ personId: 'p_d', text: 'Three', messageId: 'm_0303' }));
    await dropFactsFromMessage(db.pool, 't_goa', 'm_0302');
    const rows = await allRows('p_d');
    expect(rows.map((r) => r.text)).toEqual(['One', 'Three']);
    expect(rows[0]!.superseded_by).toBe(three.factId);
    expect((await currentFacts(db.pool, { personId: 'p_d' })).map((f) => f.text)).toEqual(['Three']);
  });
});

describe('deleteFactChain, forgetFacts and countFacts', () => {
  it('deletes a fact with its history, and nothing for a fact that is gone or someone else\'s', async () => {
    await saveFact(db.pool, fact({ personId: 'p_e', topic: 'seats', text: 'Window' }));
    const cur = await saveFact(db.pool, fact({ personId: 'p_e', topic: 'seats', text: 'Aisle' }));
    expect(await deleteFactChain(db.pool, 'p_x', cur.factId)).toBe(0);
    expect(await deleteFactChain(db.pool, 'p_e', cur.factId)).toBe(2);
    expect(await deleteFactChain(db.pool, 'p_e', cur.factId)).toBe(0);
    expect(await countFacts(db.pool, 'p_e', null)).toBe(0);
  });

  it('forgets one trip or every trip, counting only the facts the person could see', async () => {
    await saveFact(db.pool, fact({ personId: 'p_f', tripId: 't_goa', topic: 'food', text: 'Vegan' }));
    await saveFact(db.pool, fact({ personId: 'p_f', tripId: 't_goa', topic: 'food', text: 'Vegetarian' }));
    await saveFact(db.pool, fact({ personId: 'p_f', tripId: 't_goa', topic: 'boats', text: 'Gets seasick' }));
    await saveFact(db.pool, fact({ personId: 'p_f', tripId: 't_manali', topic: 'food', text: 'Vegetarian' }));
    expect(await forgetFacts(db.pool, 'p_f', 't_goa')).toBe(2);
    expect(await countFacts(db.pool, 'p_f', 't_goa')).toBe(0);
    expect(await countFacts(db.pool, 'p_f', null)).toBe(1);
    expect(await forgetFacts(db.pool, 'p_f', null)).toBe(1);
    expect(await countFacts(db.pool, 'p_f', null)).toBe(0);
  });
});

describe('carry-over and forgotten marks', () => {
  it('starts off, and turns on and off', async () => {
    expect(await getCarryOver(db.pool, 'p_g')).toBe(false);
    await setCarryOver(db.pool, 'p_g', true);
    expect(await getCarryOver(db.pool, 'p_g')).toBe(true);
    await setCarryOver(db.pool, 'p_g', false);
    expect(await getCarryOver(db.pool, 'p_g')).toBe(false);
  });

  it('keeps the highest change number a person was forgotten up to', async () => {
    await markForgotten(db.pool, 'p_h', 't_goa', 120, new Date('2026-10-06T10:00:00Z'));
    await markForgotten(db.pool, 'p_h', 't_goa', 90, new Date('2026-10-06T11:00:00Z'));
    expect((await forgottenUpTo(db.pool, 't_goa')).get('p_h')).toBe(120);
  });
});
