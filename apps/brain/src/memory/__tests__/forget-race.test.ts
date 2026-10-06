import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { silentLog } from '../../log.js';
import { fakePacks, goaTrip, msg, packOf } from '../../reflex/goa.fixture.js';
import { currentFacts, saveFact, type NewFact } from '../facts.js';
import { createFold } from '../fold.js';
import { createNotes } from '../notes.js';
import { peopleHandlers } from '../people.js';
import { fakeLink, scriptedSide, seedMessages } from './test-kit.js';

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => { db = await withSchema(); });
afterAll(async () => { await db.drop(); });

const meta = { instance: 'server-1', frameId: 'gs_1' };
const NOW = new Date('2026-10-07T10:00:00Z');

function setup(tripId: string, messages: ReturnType<typeof msg>[]) {
  const packs = fakePacks({ [tripId]: packOf(messages, goaTrip({ trip_id: tripId })) });
  const fold = createFold({
    pool: db.pool, packs, side: scriptedSide([]), log: silentLog, now: () => NOW,
    foldAtTokens: 60_000, storyTokens: 5_000, hardCapTokens: 90_000,
  });
  return { packs, people: peopleHandlers({ pool: db.pool, packs, fold, now: () => NOW, log: silentLog }) };
}

describe('a forget that lands while a save is on its way', () => {
  it('wins over a notes pass that was already reading: nothing is saved and get_person stays empty', async () => {
    const messages = [msg(130, 'p_meher', "I'm allergic to peanuts btw")];
    await seedMessages(db.pool, 't_race', messages);
    const { packs, people } = setup('t_race', messages);
    const answer = JSON.stringify({ facts: [{ person_id: 'p_meher', topic: 'food', text: 'Allergic to peanuts', message: 130 }], lines: [] });
    // The side model is still writing when Meher taps "Forget me" for this trip.
    let calls = 0;
    const side = {
      async complete(): Promise<string> {
        calls += 1;
        await people.forget_person({ person_id: 'p_meher', trip_id: 't_race' }, meta);
        return answer;
      },
    };
    const notes = createNotes({ pool: db.pool, packs, link: fakeLink(), side, log: silentLog, now: () => NOW });
    const out = await notes.run('t_race');
    expect(calls).toBe(1);
    expect(out.facts).toBe(0);
    expect(out.refused).toContain('fact: that person asked Go to forget this');
    expect(await currentFacts(db.pool, { personId: 'p_meher' })).toEqual([]);
    expect((await people.get_person({ person_id: 'p_meher' }, meta)).facts).toEqual([]);
  });

  it('refuses a save whose proof is from before the forget, and keeps one from after it', async () => {
    const before = msg(140, 'p_kabir', 'I get seasick on boats');
    await seedMessages(db.pool, 't_later', [before]);
    const { people } = setup('t_later', [before]);
    await people.forget_person({ person_id: 'p_kabir', trip_id: 't_later' }, meta);
    const fact = (over: Partial<NewFact>): NewFact => ({
      personId: 'p_kabir', tripId: 't_later', topic: 'boats', text: 'Gets seasick on boats', messageId: 'm_0140',
      saidAt: NOW, audience: 'group', source: 'message', ...over,
    });
    expect(await saveFact(db.pool, fact({}))).toEqual({ factId: null, changed: false, refused: 'forgotten' });
    // A proof the messages table does not know cannot be placed after the forget either.
    expect(await saveFact(db.pool, fact({ messageId: 'm_9999' }))).toMatchObject({ refused: 'forgotten' });
    const after = msg(150, 'p_kabir', 'Boats are fine now, I took a pill');
    await seedMessages(db.pool, 't_later', [after]);
    expect(await saveFact(db.pool, fact({ text: 'Fine on boats', messageId: 'm_0150' }))).toMatchObject({ changed: true });
    expect((await currentFacts(db.pool, { personId: 'p_kabir', tripId: 't_later' })).map((f) => f.text)).toEqual(['Fine on boats']);
  });
});
