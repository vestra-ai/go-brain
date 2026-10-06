import type * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { silentLog } from '../../log.js';
import { createCardStore, type CardStore } from '../cards.js';
import { createTapRouter } from '../taps.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let cards: CardStore;
beforeAll(async () => {
  db = await withSchema();
  cards = createCardStore({ pool: db.pool, now: () => new Date() });
  await cards.record('t_goa', working('c_work'), 'm_go_1');
  await cards.record('t_goa', { kind: 'notice', card_id: 'c_note', fallback_text: 'Note', tone: 'info', title: 'Heads up', body: 'Check-in is at 2 pm.' }, 'm_go_2');
});
afterAll(() => db.drop());

function working(id: string): C.Card {
  return {
    kind: 'working', card_id: id, fallback_text: 'Looking for villas', task_id: 'task_1', title: 'Villas in North Goa',
    state: 'running', steps: [{ text: 'Searching', state: 'doing' }], updated_at: '2026-10-05T10:00:00Z',
    actions: [{ action_id: 'watch', label: 'Watch', style: 'primary' }],
  };
}

let n = 0;
const tap = (over: Record<string, string> = {}) => ({
  tap_id: `tap_${++n}`, trip_id: 't_goa', card_id: 'c_work', action_id: 'watch', person_id: 'p_priya', ...over,
});
const meta = { instance: 'server-1', frameId: 'gs_1' };
const router = () => createTapRouter({ pool: db.pool, cards, log: silentLog });

describe('the tap router', () => {
  it('routes a tap by the card kind and the action, with the stored card', async () => {
    const r = router();
    const seen: string[] = [];
    r.on('working', 'watch', async (t, card) => {
      seen.push(`${t.person_id}:${card.kind}`);
      return { result: 'open', url: 'https://go.example/watch/abc', expires_at: '2026-10-05T10:05:00Z' };
    });
    expect(await r.handle(tap(), meta)).toEqual({ result: 'open', url: 'https://go.example/watch/abc', expires_at: '2026-10-05T10:05:00Z' });
    expect(seen).toEqual(['p_priya:working']);
  });

  it('acts once per tap_id: a repeat gets the first answer, at the same moment or after a restart', async () => {
    const r = router();
    let runs = 0;
    r.on('working', 'stop', async () => {
      runs += 1;
      return { result: 'done', toast: 'Stopped' };
    });
    const t = tap({ action_id: 'stop', tap_id: 'tap_once' });
    const [a, b] = await Promise.all([r.handle(t, meta), r.handle(t, meta)]);
    const c = await r.handle(t, meta);
    expect(runs).toBe(1);
    expect(a).toEqual({ result: 'done', toast: 'Stopped' });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    const afterRestart = router();
    expect(await afterRestart.handle(t, meta)).toEqual(a);
  });

  it('refuses kindly a card Go does not know, or a button with no handler', async () => {
    const r = router();
    expect(await r.handle(tap({ card_id: 'c_gone' }), meta)).toEqual({ result: 'refused', toast: 'That card is not active any more.' });
    expect(await r.handle(tap({ action_id: 'zoom' }), meta)).toEqual({ result: 'refused', toast: "That button doesn't do anything yet." });
  });

  it('refuses kindly when a handler is too slow or fails', async () => {
    const r = createTapRouter({ pool: db.pool, cards, log: silentLog, limitMs: 50 });
    r.on('notice', 'slow', async () => {
      await new Promise((res) => setTimeout(res, 200));
      return { result: 'done' };
    });
    r.on('notice', 'broken', async () => {
      throw new Error('boom');
    });
    expect(await r.handle(tap({ card_id: 'c_note', action_id: 'slow' }), meta)).toEqual({ result: 'refused', toast: 'That took too long. Try again in a moment.' });
    expect(await r.handle(tap({ card_id: 'c_note', action_id: 'broken' }), meta)).toEqual({ result: 'refused', toast: 'Something went wrong. Try again in a moment.' });
  });

  it('cleans the toast', async () => {
    const r = router();
    r.on('working', 'retry', async () => ({ result: 'done', toast: 'Retrying — hang on' }));
    expect(await r.handle(tap({ action_id: 'retry' }), meta)).toEqual({ result: 'done', toast: 'Retrying, hang on' });
  });

  it('dispatch answers a tap made inside Go like one from the Server, once per tap_id', async () => {
    const r = router();
    let runs = 0;
    r.on('notice', 'dismiss', async (t) => {
      runs += 1;
      return { result: 'done', toast: `Dismissed by ${t.person_id}` };
    });
    const t = tap({ card_id: 'c_note', action_id: 'dismiss', tap_id: 'tap_admin_1', person_id: 'p_rahul' });
    const first = await r.dispatch(t);
    expect(first).toEqual({ result: 'done', toast: 'Dismissed by p_rahul' });
    expect(await r.handle(t, meta)).toEqual(first);
    expect(await r.dispatch(t)).toEqual(first);
    expect(await router().dispatch(t)).toEqual(first);
    expect(runs).toBe(1);
    expect(await r.dispatch(tap({ card_id: 'c_gone', tap_id: 'tap_admin_2' }))).toEqual({ result: 'refused', toast: 'That card is not active any more.' });
  });

  it('takes routes for Go cards only; record cards belong to the Server', () => {
    const r = router();
    expect(() => r.on('vote' as never, 'pick', async () => ({ result: 'done' }))).toThrow(/Server/);
    r.on('options', 'pick', async () => ({ result: 'done' }));
    expect(() => r.on('options', 'pick', async () => ({ result: 'done' }))).toThrow(/already/);
  });
});

describe('the card store', () => {
  it('keeps every card Go posts or replaces, with its message', async () => {
    await cards.observe('post_message', { trip_id: 't_goa', request_id: 'go_x', card: working('c_new') }, { message_id: 'm_go_7', seq: 7 });
    await cards.observe('replace_card', { trip_id: 't_goa', card: { ...working('c_new'), state: 'done' } }, { message_id: 'm_go_7' });
    await cards.observe('post_message', { trip_id: 't_goa', request_id: 'go_y', text: 'no card here' }, { message_id: 'm_go_8', seq: 8 });
    expect(await cards.get('t_goa', 'c_new')).toMatchObject({ kind: 'working', state: 'done' });
    const { rows } = await db.pool.query(`select message_id from cards where trip_id = 't_goa' and card_id = 'c_new'`);
    expect(rows[0].message_id).toBe('m_go_7');
    expect(await cards.get('t_goa', 'c_missing')).toBeNull();
  });
});
