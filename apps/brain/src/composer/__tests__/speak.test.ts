import type * as C from '@go/contract';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLink } from '../../__tests__/fixtures/fake-link.js';
import { withSchema } from '../../db/test-db.js';
import { atNames, createSpeak, mentionsIn } from '../speak.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

const notice = (id: string): C.Card => ({ kind: 'notice', card_id: id, fallback_text: `Note ${id}`, tone: 'info', title: 'Heads up', body: 'Check-in is at 2 pm.' });

describe('typing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('goes on at once, repeats every 5 s while a turn works, and goes off once', () => {
    const { link, notes } = fakeLink();
    const speak = createSpeak({ pool: {} as pg.Pool, link, now: () => new Date() });
    speak.typingOn('t_goa');
    expect(notes).toEqual([{ method: 'typing', params: { trip_id: 't_goa', on: true } }]);
    speak.working('t_goa');
    vi.advanceTimersByTime(12_000);
    expect(notes.filter((n) => n.params.on)).toHaveLength(3);
    speak.typingOff('t_goa');
    speak.typingOff('t_goa');
    expect(notes.at(-1)).toEqual({ method: 'typing', params: { trip_id: 't_goa', on: false } });
    expect(notes.filter((n) => !n.params.on)).toHaveLength(1);
  });

  it('stays honest: goes off by itself when no turn keeps it alive', () => {
    const { link, notes } = fakeLink();
    const speak = createSpeak({ pool: {} as pg.Pool, link, now: () => new Date() });
    speak.typingOn('t_goa');
    vi.advanceTimersByTime(15_000);
    expect(notes.at(-1)?.params.on).toBe(false);
  });

  it('working() turns typing on when it was off, and says when it first went on', () => {
    const { link, notes } = fakeLink();
    const speak = createSpeak({ pool: {} as pg.Pool, link, now: () => new Date('2026-10-06T09:00:00Z') });
    const since = speak.working('t_goa');
    expect(since.toISOString()).toBe('2026-10-06T09:00:00.000Z');
    expect(notes).toEqual([{ method: 'typing', params: { trip_id: 't_goa', on: true } }]);
    speak.stopAll();
    expect(notes.at(-1)?.params.on).toBe(false);
  });
});

describe('post', () => {
  it('sends the text with the first card and the other cards after, each with a stable request id, cleaned', async () => {
    const { link, calls } = fakeLink({ post_message: () => ({ message_id: `m_go_${calls.length}`, seq: 10 + calls.length }) });
    await db.pool.query(`insert into turns (turn_id, trip_id, woke_for, started_at, model) values ('turn_A', 't_goa', '{message}', now(), 'm')`);
    const speak = createSpeak({ pool: db.pool, link, now: () => new Date() });
    let n = 0;
    const ids = await speak.post({
      link,
      tripId: 't_goa',
      turnId: 'turn_A',
      requestId: (tag) => `go_${tag}_turn_A_${++n}`,
      text: 'Here you go — two picks',
      cards: [notice('c_1'), notice('c_2')],
      replyTo: 'm_4',
    });
    expect(ids).toEqual(['m_go_1', 'm_go_2']);
    expect(calls.map((c) => c.params.request_id)).toEqual(['go_post_turn_A_1', 'go_post_turn_A_2']);
    expect(calls[0]?.params).toMatchObject({ trip_id: 't_goa', text: 'Here you go, two picks', card: { card_id: 'c_1' }, reply_to: 'm_4' });
    expect(calls[1]?.params.text).toBeUndefined();
    expect(calls[1]?.params.card.card_id).toBe('c_2');
    const { rows } = await db.pool.query(`select posted_at from turns where turn_id = 'turn_A'`);
    expect(rows[0].posted_at).toBeInstanceOf(Date);
  });

  it('puts 1.1 quick replies under the words, on the first message only, cleaned; never without words', async () => {
    const { link, calls } = fakeLink({ post_message: () => ({ message_id: `m_go_${calls.length}`, seq: 20 + calls.length }) });
    await db.pool.query(`insert into turns (turn_id, trip_id, woke_for, started_at, model) values ('turn_Q', 't_goa', '{message}', now(), 'm')`);
    const speak = createSpeak({ pool: db.pool, link, now: () => new Date() });
    let n = 0;
    const replies = [{ label: 'North Goa' }, { label: 'South Goa — calmer', text: '@Go South Goa please' }];
    await speak.post({ link, tripId: 't_goa', turnId: 'turn_Q', requestId: (tag) => `go_${tag}_Q_${++n}`, text: 'North or South?', cards: [notice('c_3')], quickReplies: replies });
    expect(calls[0]?.params.quick_replies).toEqual([{ label: 'North Goa' }, { label: 'South Goa, calmer', text: '@Go South Goa please' }]);
    expect(calls[1]?.params.quick_replies).toBeUndefined();
    // A card alone carries none: the replies answer Go's words.
    await speak.post({ link, tripId: 't_goa', turnId: 'turn_Q', requestId: (tag) => `go_${tag}_Q_${++n}`, text: null, cards: [notice('c_4')], quickReplies: replies });
    expect(calls[2]?.params.quick_replies).toBeUndefined();
  });

  it("never posts Go's own ids: the line goa-300:175 posted in run 37586604675 goes out without its card id", async () => {
    const { link, calls } = fakeLink({ post_message: () => ({ message_id: 'm_go_8', seq: 8 }) });
    const speak = createSpeak({ pool: db.pool, link, now: () => new Date() });
    await speak.post({
      link, tripId: 't_goa', turnId: 'turn_C', requestId: (tag) => `go_${tag}_turn_C_1`,
      text: "I'll put the most recent villa options card (c_opt_turn_01M4AKVFEWCWYK4RFMB0MP8R97_1) to a vote.",
      cards: [notice('c_8')],
    });
    expect(calls[0]?.params.text).toBe("I'll put the most recent villa options card to a vote.");
    expect(calls[0]?.params.card.card_id).toBe('c_8');
  });

  it("cuts a cited message whole, bracket and all: goa-300:9 in run 37590000837 posted \"after 6 pm ('s thread), so\"", async () => {
    const { link, calls } = fakeLink({ post_message: () => ({ message_id: 'm_go_7', seq: 7 }) });
    const speak = createSpeak({ pool: db.pool, link, now: () => new Date() });
    await speak.post({
      link, tripId: 't_goa', turnId: 'turn_D', requestId: (tag) => `go_${tag}_turn_D_1`,
      text: "Rahul can leave Fri after 6 pm (#7's thread), so here are the evening flights that fit; the 6:15 am one is cheapest but too early for Arjun.",
      cards: [],
    });
    expect(calls[0]?.params.text).toBe('Rahul can leave Fri after 6 pm, so here are the evening flights that fit; the 6:15 am one is cheapest but too early for Arjun.');
  });

  it('posts a card with no text, and nothing when there is nothing to post', async () => {
    const { link, calls } = fakeLink({ post_message: () => ({ message_id: 'm_go_9', seq: 9 }) });
    const speak = createSpeak({ pool: db.pool, link, now: () => new Date() });
    const base = { link, tripId: 't_goa', turnId: 'turn_B', requestId: (tag: string) => `go_${tag}_turn_B_1` };
    expect(await speak.post({ ...base, text: null, cards: [] })).toEqual([]);
    expect(await speak.post({ ...base, text: '   ', cards: [] })).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(await speak.post({ ...base, text: null, cards: [notice('c_9')] })).toEqual(['m_go_9']);
    expect(calls[0]?.params.text).toBeUndefined();
  });
});

describe('mentions: the people Go names get a push', () => {
  const person = (person_id: string, name: string, go_paused = false) => ({ person_id, name, go_paused });
  const trip = [person('p_asha', 'Asha'), person('p_priya', 'Priya Shah'), person('p_rahul', 'Rahul'), person('p_meher', 'Meher', true)];

  it('a person Go names by first name goes in, as a whole word, next to any punctuation', () => {
    expect(mentionsIn("Asha, you're the payer, so tap Yes, book it.", trip)).toEqual(['p_asha']);
    expect(mentionsIn('Rahul bhai, Priya ko bolo!', trip)).toEqual(['p_priya', 'p_rahul']);
    expect(mentionsIn('@asha?', trip)).toEqual(['p_asha']);
  });

  it('a name inside another word is not that person: Asha is not in Ashanti', () => {
    expect(mentionsIn('Ashanti says hi, and the Rahulpur bus leaves at 6.', trip)).toEqual([]);
  });

  it('two people both go in, each once; never someone who paused Go, never a member named Go', () => {
    expect(mentionsIn('Priya and Rahul are in. Priya, you pay.', trip)).toEqual(['p_priya', 'p_rahul']);
    expect(mentionsIn('Meher, the villa wants a code.', trip)).toEqual([]);
    expect(mentionsIn('Go here, Go there.', [...trip, person('p_go', 'Go')])).toEqual([]);
  });

  it('a first name two people share goes only to the one named in full', () => {
    const twins = [person('p_r1', 'Rahul Mehta'), person('p_r2', 'Rahul Kapoor')];
    expect(mentionsIn('Rahul, can you check?', twins)).toEqual([]);
    expect(mentionsIn('Rahul Kapoor, can you check?', twins)).toEqual(['p_r2']);
  });

  it('post sends the named people as mentions with the text, and given mentions as they are', async () => {
    const { link, calls } = fakeLink({ post_message: () => ({ message_id: `m_go_${calls.length}`, seq: 20 + calls.length }) });
    const speak = createSpeak({ pool: db.pool, link, now: () => new Date() });
    const base = { link, tripId: 't_goa', turnId: 'turn_M', requestId: (tag: string) => `go_${tag}_turn_M_${calls.length + 1}`, cards: [] };
    await speak.post({ ...base, text: "Asha, you're the payer, so tap Yes, book it.", people: trip });
    expect(calls[0]?.params.mentions).toEqual(['p_asha']);
    await speak.post({ ...base, text: 'Nobody named here.', people: trip });
    expect(calls[1]?.params.mentions).toBeUndefined();
    await speak.post({ ...base, text: 'Asha!', people: trip, mentions: ['p_rahul'] });
    expect(calls[2]?.params.mentions).toEqual(['p_rahul']);
  });
});

// Keshav, 11 Oct: "directed messages should send @name".
describe('@names: Go addresses people as @FirstName', () => {
  const person = (person_id: string, name: string, go_paused = false) => ({ person_id, name, go_paused });
  const trip = [person('p_saket', 'Saket Diwakar'), person('p_r1', 'Rahul Mehta'), person('p_r2', 'Rahul Kapoor'), person('p_meher', 'Meher', true), person('p_asha', 'Asha')];

  it("writes each @name Go wrote as that person's first name, in full only when two people share it", () => {
    expect(atNames('@saket, tap Log in to ixigo.', trip)).toBe('@Saket, tap Log in to ixigo.');
    expect(atNames('@Saket Diwakar can you check?', trip)).toBe('@Saket can you check?');
    expect(atNames('@rahul kapoor, your fare is up.', trip)).toBe('@Rahul Kapoor, your fare is up.');
    expect(atNames('@ASHA and @saket!', trip)).toBe('@Asha and @Saket!');
  });

  it('leaves an @name that is nobody, more than one person, someone who paused Go, a longer word, or inside an address', () => {
    expect(atNames('@Rahul, which one?', trip)).toBe('@Rahul, which one?');
    expect(atNames('@Kabir, hi', trip)).toBe('@Kabir, hi');
    expect(atNames('@meher, hi', trip)).toBe('@meher, hi');
    expect(atNames('@Ashanti is not Asha', trip)).toBe('@Ashanti is not Asha');
    expect(atNames('Write to help@asha.com', trip)).toBe('Write to help@asha.com');
  });

  it('post writes the @names and mentions those people; a private post mentions only who can see it', async () => {
    const { link, calls } = fakeLink({ post_message: () => ({ message_id: `m_go_${calls.length}`, seq: 40 + calls.length }) });
    const speak = createSpeak({ pool: db.pool, link, now: () => new Date() });
    const base = { link, tripId: 't_goa', turnId: 'turn_A', requestId: (tag: string) => `go_${tag}_turn_A_${calls.length + 1}`, cards: [] };
    await speak.post({ ...base, text: '@saket, tap Log in to ixigo. @asha, you pay.', people: trip });
    expect(calls[0]?.params).toMatchObject({ text: '@Saket, tap Log in to ixigo. @Asha, you pay.', mentions: ['p_saket', 'p_asha'] });
    expect(calls[0]?.params).not.toHaveProperty('visible_to_person_ids');
    await speak.post({ ...base, text: '@Saket, your fare. @Asha sees nothing.', people: trip, visibleTo: ['p_saket'] });
    expect(calls[1]?.params).toMatchObject({ mentions: ['p_saket'], visible_to_person_ids: ['p_saket'] });
  });
});
