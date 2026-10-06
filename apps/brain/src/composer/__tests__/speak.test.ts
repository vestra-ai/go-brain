import type * as C from '@go/contract';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLink } from '../../__tests__/fixtures/fake-link.js';
import { withSchema } from '../../db/test-db.js';
import { createSpeak } from '../speak.js';

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
