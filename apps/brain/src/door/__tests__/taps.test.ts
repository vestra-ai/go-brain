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

describe('a card Go has sent, before the Server answers', () => {
  const posted = (id: string): Record<string, unknown> => ({ request_id: `go_post_${id}`, trip_id: 't_goa', card: working(id) });
  const pendingOf = async (id: string): Promise<boolean | null> =>
    (await db.pool.query<{ pending: boolean }>('select pending from cards where trip_id = $1 and card_id = $2', ['t_goa', id])).rows[0]?.pending ?? null;
  const withWatch = () => {
    const r = router();
    let runs = 0;
    r.on('working', 'watch', async () => {
      runs += 1;
      return { result: 'done', toast: 'Watching' };
    });
    return { r, runs: () => runs };
  };

  it('is tappable at once: a tap from the Server is handled once and proves the card landed', async () => {
    const { r, runs } = withWatch();
    await cards.sending('post_message', posted('c_fresh'));
    expect(await pendingOf('c_fresh')).toBe(true);
    const t = tap({ card_id: 'c_fresh', tap_id: 'tap_fresh' });
    const [a, b] = await Promise.all([r.handle(t, meta), r.handle(t, meta)]);
    expect(a).toEqual({ result: 'done', toast: 'Watching' });
    expect(b).toEqual(a);
    expect(await r.handle(t, meta)).toEqual(a);
    expect(runs()).toBe(1);
    expect(await pendingOf('c_fresh')).toBe(false);
    // The Server's answer comes after the tap: the card stays, now with its message id.
    await cards.observe('post_message', posted('c_fresh'), { message_id: 'm_go_fresh', seq: 40 });
    const { rows } = await db.pool.query('select pending, message_id from cards where trip_id = $1 and card_id = $2', ['t_goa', 'c_fresh']);
    expect(rows[0]).toEqual({ pending: false, message_id: 'm_go_fresh' });
  });

  it('is gone once its post fails, so a later tap is refused as before', async () => {
    const { r, runs } = withWatch();
    await cards.sending('post_message', posted('c_refused'));
    await cards.failed('post_message', posted('c_refused'));
    expect(await pendingOf('c_refused')).toBeNull();
    expect(await r.handle(tap({ card_id: 'c_refused' }), meta)).toEqual({ result: 'refused', toast: 'That card is not active any more.' });
    expect(runs()).toBe(0);
  });

  it('stays when its post fails after a tap proved it landed (the answer was lost, not the card)', async () => {
    const { r } = withWatch();
    await cards.sending('post_message', posted('c_landed'));
    expect(await r.handle(tap({ card_id: 'c_landed' }), meta)).toEqual({ result: 'done', toast: 'Watching' });
    await cards.failed('post_message', posted('c_landed'));
    expect(await pendingOf('c_landed')).toBe(false);
    expect(await r.handle(tap({ card_id: 'c_landed' }), meta)).toEqual({ result: 'done', toast: 'Watching' });
  });

  it('races a Server tap against a failed post, and never lets both win: handled with the card kept, or refused with it gone', async () => {
    const { r, runs } = withWatch();
    let handled = 0;
    for (let k = 0; k < 20; k++) {
      const id = `c_vs_${k}`;
      await cards.sending('post_message', posted(id));
      const [answer] = await Promise.all([r.handle(tap({ card_id: id, tap_id: `tap_vs_${k}` }), meta), cards.failed('post_message', posted(id))]);
      if (answer.result === 'done') {
        handled += 1;
        expect(await pendingOf(id), id).toBe(false);
      } else {
        expect(answer, id).toEqual({ result: 'refused', toast: 'That card is not active any more.' });
        expect(await pendingOf(id), id).toBeNull();
      }
    }
    expect(runs()).toBe(handled);
  });

  it('is not proved by a tap made inside Go', async () => {
    const { r } = withWatch();
    await cards.sending('post_message', posted('c_inside'));
    expect(await r.dispatch(tap({ card_id: 'c_inside', tap_id: 'tap_inside' }))).toEqual({ result: 'done', toast: 'Watching' });
    expect(await pendingOf('c_inside')).toBe(true);
  });

  it('is kept once however often the post is sent again, and a live card never goes back to pending', async () => {
    await cards.sending('post_message', posted('c_twice'));
    await cards.sending('post_message', posted('c_twice'));
    const count = async () => (await db.pool.query<{ n: number }>('select count(*)::int as n from cards where card_id = $1', ['c_twice'])).rows[0]?.n;
    expect(await count()).toBe(1);
    await cards.observe('post_message', posted('c_twice'), { message_id: 'm_go_twice', seq: 41 });
    await cards.sending('post_message', posted('c_twice'));
    await cards.failed('post_message', posted('c_twice'));
    expect(await count()).toBe(1);
    expect(await pendingOf('c_twice')).toBe(false);
  });

  it('is only a post with a card: text and replace_card add nothing pending, and a failed replace never takes a card away', async () => {
    await cards.sending('post_message', { request_id: 'go_text', trip_id: 't_goa', text: 'Hi all' });
    await cards.sending('replace_card', { trip_id: 't_goa', card: working('c_replaced') });
    expect(await pendingOf('c_replaced')).toBeNull();
    await cards.failed('replace_card', { trip_id: 't_goa', card: working('c_work') });
    expect(await cards.get('t_goa', 'c_work')).not.toBeNull();
  });
});
