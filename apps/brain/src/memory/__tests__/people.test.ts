import * as C from '@go/contract';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { SocketCallError } from '../../door/rpc.js';
import { fakePacks, goaTrip, msg, packOf } from '../../reflex/goa.fixture.js';
import { silentLog } from '../../log.js';
import { checkFact } from '../checker.js';
import { countFacts, forgottenUpTo, saveFact, type NewFact } from '../facts.js';
import { createFold } from '../fold.js';
import { drawPage } from '../pages.js';
import { forgotElsewhere, forgotElsewhereNote, forgotElsewhereNow } from '../forget-elsewhere.js';
import { emptyCatchUp, peopleHandlers } from '../people.js';
import { recall } from '../recall.js';
import { scriptedSide, seedMessages } from './test-kit.js';

let db: { pool: Pool; drop: () => Promise<void> };
const meta = { instance: 'server-1', frameId: 'gs_1' };
const goaMsgs = [
  msg(105, 'p_priya', 'Vegetarian, no fish for me'),
  msg(106, 'p_priya', 'Window seat please'),
  msg(141, 'p_kabir', 'Aisle seat for me always'),
  msg(142, 'p_meher', "I'm allergic to peanuts"),
  msg(188, 'p_kabir', 'I get seasick on boats, so no cruise'),
];
const manaliMsgs = [msg(20, 'p_kabir', 'Paneer everything please'), msg(21, 'p_priya', 'I eat fish now')];
const packs = fakePacks({
  t_goa: packOf(goaMsgs, goaTrip()),
  t_manali: packOf(manaliMsgs, goaTrip({ trip_id: 't_manali', title: 'Manali' })),
});
const fact = (over: Partial<NewFact>): NewFact => ({
  personId: 'p_kabir', tripId: 't_goa', topic: 'boats', text: 'Gets seasick on boats', messageId: 'm_0188',
  saidAt: new Date('2026-10-05T07:08:00Z'), audience: 'group', source: 'message', ...over,
});
let h: ReturnType<typeof peopleHandlers>;
let flightsId = '';

beforeAll(async () => {
  db = await withSchema();
  await seedMessages(db.pool, 't_goa', goaMsgs);
  await seedMessages(db.pool, 't_manali', manaliMsgs);
  await saveFact(db.pool, fact({ topic: 'drinks', text: "Doesn't drink", messageId: null, source: 'join' }));
  flightsId = (await saveFact(db.pool, fact({ topic: 'flights', text: 'Wants an aisle seat', messageId: 'm_0141' }))).factId;
  await saveFact(db.pool, fact({ text: 'Fine on boats' }));
  await saveFact(db.pool, fact({ text: 'Gets seasick on boats' }));
  await saveFact(db.pool, fact({ tripId: 't_manali', topic: 'food', text: 'Loves paneer', messageId: 'm_0020' }));
  await saveFact(db.pool, fact({ personId: 'p_meher', topic: 'food', text: 'Allergic to peanuts', messageId: 'm_0142' }));
  // Priya's food fact differs between her trips; the Manali one is newer.
  await saveFact(db.pool, fact({ personId: 'p_priya', topic: 'food', text: 'Vegetarian', messageId: 'm_0105', saidAt: new Date('2026-10-05T06:00:00Z') }));
  await saveFact(db.pool, fact({ personId: 'p_priya', topic: 'seats', text: 'Window seat', messageId: 'm_0106', saidAt: new Date('2026-10-05T06:01:00Z') }));
  await saveFact(db.pool, fact({
    personId: 'p_priya', tripId: 't_manali', topic: 'food', text: 'Eats fish now', messageId: 'm_0021', saidAt: new Date('2026-12-01T06:00:00Z'),
  }));
  await db.pool.query(
    `INSERT INTO story_lines (trip_id, idx, text, refs, ref_ids, people) VALUES
       ('t_goa', 0, 'Kabir books the airport cab', '{150}', '{m_0150}', '{}'),
       ('t_goa', 1, 'Someone gets seasick, so no cruise', '{188}', '{m_0188}', '{p_kabir}'),
       ('t_goa', 2, 'Meher is allergic to peanuts', '{142}', '{m_0142}', '{p_meher}'),
       ('t_manali', 0, 'Kabir wants paneer everywhere', '{20}', '{m_0020}', '{p_kabir}')`,
  );
  const fold = createFold({
    pool: db.pool, packs, side: scriptedSide([]), log: silentLog, now: () => new Date(),
    foldAtTokens: 60_000, storyTokens: 5_000, hardCapTokens: 90_000,
  });
  h = peopleHandlers({ pool: db.pool, packs, fold, now: () => new Date('2026-10-07T12:00:00Z'), log: silentLog });
});
afterAll(async () => { await db.drop(); });

describe('get_person and update_person', () => {
  it('answers a page that validates, current facts only, one per topic, from every trip', async () => {
    const page = await h.get_person({ person_id: 'p_kabir' }, meta);
    expect(C.PersonPage.safeParse(page).success).toBe(true);
    expect(page.carry_over).toBe(false);
    expect(page.facts.map((f) => [f.trip_id, f.topic, f.text]).sort()).toEqual([
      ['t_goa', 'boats', 'Gets seasick on boats'],
      ['t_goa', 'drinks', "Doesn't drink"],
      ['t_goa', 'flights', 'Wants an aisle seat'],
      ['t_manali', 'food', 'Loves paneer'],
    ]);
    expect(page.facts.find((f) => f.topic === 'drinks')!.message_id).toBeNull();
  });

  it('turns carry-over on', async () => {
    expect(await h.update_person({ person_id: 'p_kabir', carry_over: true }, meta)).toEqual({ ok: true });
    expect((await h.get_person({ person_id: 'p_kabir' }, meta)).carry_over).toBe(true);
    await h.update_person({ person_id: 'p_kabir', carry_over: false }, meta);
  });
});

describe('one current fact per topic (guide 05)', () => {
  it('answers one food fact for Priya, the newest across her trips, while the Goa page keeps Goa\'s', async () => {
    const page = await h.get_person({ person_id: 'p_priya' }, meta);
    expect(C.PersonPage.safeParse(page).success).toBe(true);
    expect(page.facts.map((f) => [f.topic, f.text, f.trip_id]).sort()).toEqual([
      ['food', 'Eats fish now', 't_manali'],
      ['seats', 'Window seat', 't_goa'],
    ]);
    expect(await drawPage(db.pool, 't_goa', 'p_priya', 'group')).toContain('- food: Vegetarian (#105)');
    await h.update_person({ person_id: 'p_priya', carry_over: true }, meta);
    const withCarry = await drawPage(db.pool, 't_goa', 'p_priya', 'group');
    expect(withCarry).toContain('- food: Vegetarian (#105)');
    expect(withCarry).not.toContain('fish now');
    await h.update_person({ person_id: 'p_priya', carry_over: false }, meta);
  });

  it('deletes the row a fact_id names; the other trip\'s fact on that topic is then the newest', async () => {
    const manaliFood = (await h.get_person({ person_id: 'p_priya' }, meta)).facts.find((f) => f.topic === 'food')!;
    expect(manaliFood.trip_id).toBe('t_manali');
    expect(await h.delete_fact({ person_id: 'p_priya', fact_id: manaliFood.fact_id }, meta)).toEqual({ ok: true });
    const after = await h.get_person({ person_id: 'p_priya' }, meta);
    expect(after.facts.filter((f) => f.topic === 'food').map((f) => [f.text, f.trip_id])).toEqual([['Vegetarian', 't_goa']]);
    expect(await countFacts(db.pool, 'p_priya', 't_manali')).toBe(0);
    expect(await drawPage(db.pool, 't_goa', 'p_priya', 'group')).toContain('- food: Vegetarian (#105)');
  });
});

describe('delete_fact', () => {
  it('deletes one fact, and answers 404 not_found for one that is already gone', async () => {
    expect(await h.delete_fact({ person_id: 'p_kabir', fact_id: flightsId }, meta)).toEqual({ ok: true });
    const err = await h.delete_fact({ person_id: 'p_kabir', fact_id: flightsId }, meta).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocketCallError);
    expect((err as SocketCallError).code).toBe(404);
    expect((await h.get_person({ person_id: 'p_kabir' }, meta)).facts.some((f) => f.topic === 'flights')).toBe(false);
  });
});

describe('forget_person (master §10 item 5)', () => {
  it('forgets one trip: no fact, no page line, no recall hit, no story mention, checked by queries', async () => {
    const res = await h.forget_person({ person_id: 'p_kabir', trip_id: 't_goa' }, meta);
    expect(C.ForgetResult.safeParse(res).success).toBe(true);
    expect(res).toEqual({ deleted_facts: 2, remaining_facts: 0 });
    expect(await countFacts(db.pool, 'p_kabir', 't_goa')).toBe(0);
    expect(await drawPage(db.pool, 't_goa', 'p_kabir', 'go')).toBe('');
    const forgotten = await forgottenUpTo(db.pool, 't_goa');
    const hits = await recall(db.pool, await packs.get('t_goa'), forgotten, 'seasick boats cruise aisle', 'go');
    expect(hits.some((x) => x.messageId === 'm_0188' || x.messageId === 'm_0141')).toBe(false);
    const story = (await db.pool.query('SELECT text FROM story_lines WHERE trip_id = $1 ORDER BY idx', ['t_goa'])).rows;
    expect(story).toEqual([{ text: 'Meher is allergic to peanuts' }]);
    expect(await countFacts(db.pool, 'p_kabir', 't_manali')).toBe(1);
    expect(await countFacts(db.pool, 'p_meher', 't_goa')).toBe(1);
  });

  it('is safe to repeat', async () => {
    expect(await h.forget_person({ person_id: 'p_kabir', trip_id: 't_goa' }, meta)).toEqual({ deleted_facts: 0, remaining_facts: 0 });
  });

  it('still learns from what the person says after the forget', async () => {
    const later = msg(300, 'p_kabir', 'I can swim now, scuba is fine');
    const env = { pack: packOf([...goaMsgs, later], goaTrip()), forgotten: await forgottenUpTo(db.pool, 't_goa'), record: [] };
    expect(checkFact({ person_id: 'p_kabir', topic: 'water', text: 'Can swim', message_id: 'm_0300' }, env).ok).toBe(true);
    expect(checkFact({ person_id: 'p_kabir', topic: 'boats', text: 'Seasick', message_id: 'm_0188' }, env).ok).toBe(false);
  });

  it('forgets everywhere without a trip id', async () => {
    expect(await h.forget_person({ person_id: 'p_kabir' }, meta)).toEqual({ deleted_facts: 1, remaining_facts: 0 });
    expect(await countFacts(db.pool, 'p_kabir', null)).toBe(0);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM story_lines WHERE trip_id = 't_manali'")).rows[0].n).toBe(0);
  });

  it('tells only the person, on a notice pinned to them that names nobody, in each trip it forgets; a card that fails never fails the forget', async () => {
    const told: Array<{ tripId: string; personId: string; card: C.Card }> = [];
    const telling = peopleHandlers({
      pool: db.pool, packs, fold: { redactPerson: async () => 0, storyMentions: async () => 0 }, now: () => new Date('2026-10-08T12:00:00Z'), log: silentLog,
      tellPerson: async (tripId, personId, card) => {
        told.push({ tripId, personId, card });
        if (tripId === 't_manali') throw new Error('the Server is away');
      },
    });
    await saveFact(db.pool, fact({ personId: 'p_meher', tripId: 't_goa', topic: 'food', text: 'Vegetarian', messageId: null, source: 'join' }));
    await saveFact(db.pool, fact({ personId: 'p_meher', tripId: 't_manali', topic: 'food', text: 'Vegetarian', messageId: null, source: 'join' }));
    expect(await telling.forget_person({ person_id: 'p_meher', trip_id: 't_goa' }, meta)).toMatchObject({ remaining_facts: 0 });
    expect(told.map((t) => [t.tripId, t.personId])).toEqual([['t_goa', 'p_meher']]);
    const card = told[0]!.card;
    expect(C.Card.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({ kind: 'notice', for_person_ids: ['p_meher'] });
    expect(card.card_id.length).toBeLessThanOrEqual(64);
    // It says "you", never a name: nothing anyone can read on it says who used Forget me (for_person_ids is the pin).
    const words = JSON.stringify({ ...card, for_person_ids: null });
    for (const name of ['Meher', 'p_meher', 'Kabir', 'Priya']) expect(words).not.toContain(name);
    // Everywhere: one card per trip, and the trip whose card failed is still forgotten.
    await saveFact(db.pool, fact({ personId: 'p_meher', tripId: 't_goa', topic: 'food', text: 'Vegan now', messageId: null, source: 'join' }));
    expect(await telling.forget_person({ person_id: 'p_meher' }, meta)).toMatchObject({ remaining_facts: 0 });
    expect(told.slice(1).map((t) => t.tripId).sort()).toEqual(['t_goa', 't_manali']);
    expect(await countFacts(db.pool, 'p_meher', null)).toBe(0);
  });

  it("lets go of the trip's ixigo login in each trip it forgets, and a login that can't be let go never fails the forget", async () => {
    const gone: Array<[string, string]> = [];
    const withLogin = peopleHandlers({
      pool: db.pool, packs, fold: { redactPerson: async () => 0, storyMentions: async () => 0 }, now: () => new Date(), log: silentLog,
      loginGone: async (tripId, personId) => {
        gone.push([tripId, personId]);
        if (tripId === 't_manali') throw new Error('the login card could not be replaced');
      },
    });
    await saveFact(db.pool, fact({ personId: 'p_rahul', tripId: 't_goa', topic: 'food', text: 'Loves prawns', messageId: null, source: 'join' }));
    await saveFact(db.pool, fact({ personId: 'p_rahul', tripId: 't_manali', topic: 'food', text: 'Loves momos', messageId: null, source: 'join' }));
    expect(await withLogin.forget_person({ person_id: 'p_rahul', trip_id: 't_goa' }, meta)).toEqual({ deleted_facts: 1, remaining_facts: 0 });
    expect(gone).toEqual([['t_goa', 'p_rahul']]);
    // Everywhere: each trip Go still holds anything of theirs in (Manali, here), and one that throws still answers.
    expect(await withLogin.forget_person({ person_id: 'p_rahul' }, meta)).toEqual({ deleted_facts: 1, remaining_facts: 0 });
    expect(gone.slice(1)).toEqual([['t_manali', 'p_rahul']]);
  });

  it('refuses to answer, and changes nothing, when something would be left', async () => {
    await saveFact(db.pool, fact({ personId: 'p_arjun', topic: 'flights', text: 'No early flights', messageId: null, source: 'join' }));
    const stubborn = peopleHandlers({
      pool: db.pool, packs, now: () => new Date(), log: silentLog,
      fold: { redactPerson: async () => 0, storyMentions: async () => 1 },
    });
    const err = await stubborn.forget_person({ person_id: 'p_arjun', trip_id: 't_goa' }, meta).catch((e: unknown) => e);
    expect((err as SocketCallError).code).toBe(500);
    expect(await countFacts(db.pool, 'p_arjun', 't_goa')).toBe(1);
  });

  it("reaches the person's other trips when their facts carried there: Go is told never to repeat its own words about them (staging, 10 Oct)", async () => {
    const plain = peopleHandlers({ pool: db.pool, packs, fold: { redactPerson: async () => 0, storyMentions: async () => 0 }, now: () => new Date('2026-10-10T01:14:00Z'), log: silentLog });
    // Carry-over off: the trip's facts never showed in another trip, so nothing else is marked.
    await saveFact(db.pool, fact({ personId: 'p_meher', tripId: 't_manali', topic: 'flights', text: 'Dislikes early flights', messageId: null, source: 'join' }));
    expect(await plain.forget_person({ person_id: 'p_meher', trip_id: 't_goa' }, meta)).toMatchObject({ remaining_facts: 0 });
    expect(await forgotElsewhere(db.pool, 't_manali')).toEqual([]);
    // Carry-over on: the other trip is marked, and its turns hear it under "right now", naming nobody's facts.
    await plain.update_person({ person_id: 'p_priya', carry_over: true }, meta);
    expect(await plain.forget_person({ person_id: 'p_priya', trip_id: 't_goa' }, meta)).toMatchObject({ remaining_facts: 0 });
    expect(await forgotElsewhere(db.pool, 't_manali')).toEqual(['p_priya']);
    expect(await forgotElsewhere(db.pool, 't_goa')).toEqual([]);
    const note = await forgotElsewhereNow({ pool: db.pool, packs }).render('t_manali', []);
    expect(note).toBe(
      'Priya had Go forget what it learned about them in another trip, and your own earlier messages here may repeat it. ' +
        'Never repeat anything about Priya from your own earlier messages in this chat: use only what they or the group say in this trip, ' +
        'and what "right now" shows. Never mention the forget.',
    );
    expect(await forgotElsewhereNow({ pool: db.pool, packs }).render('t_goa', [])).toBeNull();
    // Her Manali facts are hers to keep: only the Goa trip was forgotten.
    expect(await countFacts(db.pool, 'p_priya', 't_manali')).toBe(1);
    expect(forgotElsewhereNote(['Priya', 'Arjun'])).toContain('Priya and Arjun had Go forget');
    expect(forgotElsewhereNote([])).toBeNull();
  });
});

describe('catch_up until Task 13 lands', () => {
  it('answers a valid, empty catch-up at once, so the Server never gets -32601', async () => {
    const started = Date.now();
    const res = await emptyCatchUp()({ trip_id: 't_goa', person_id: 'p_meher', since: '2026-10-05T05:00:00Z' }, meta);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(C.CatchUp.safeParse(res).success).toBe(true);
    expect(res).toEqual({ items: [] });
  });
});

describe('forget everywhere finds every trip', () => {
  it('reaches a trip where only a story line names the person, through the person index', async () => {
    const idx = await db.pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'messages' AND indexname = 'messages_by_person'`);
    expect(idx.rows).toHaveLength(1);
    await db.pool.query(
      `INSERT INTO story_lines (trip_id, idx, text, refs, ref_ids, people) VALUES ('t_story', 0, 'Zed brings the speaker', '{3}', '{m_0003}', '{p_zed}')`,
    );
    expect(await h.forget_person({ person_id: 'p_zed' }, meta)).toEqual({ deleted_facts: 0, remaining_facts: 0 });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM story_lines WHERE trip_id = 't_story'`)).rows[0].n).toBe(0);
    expect((await forgottenUpTo(db.pool, 't_story')).has('p_zed')).toBe(true);
  });
});
