import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import * as C from '@go/contract';
import { FakeLink, eventually, makeLaneBrain } from '../lane-brain.js';
import { GOA_MESSAGES, GOA_TRIP, goaPack } from '../goa.js';

const notice = { card_id: 'c_1', kind: 'notice', fallback_text: 'Hi', tone: 'info', title: 'Hi', body: 'Hello' } as const;

describe('the Goa fixture', () => {
  it('is a valid trip snapshot with the five people of the guide, and valid messages', () => {
    expect(C.TripSnapshot.safeParse(GOA_TRIP).success).toBe(true);
    expect(GOA_TRIP.people.map((p) => p.person_id)).toEqual(['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']);
    expect(GOA_MESSAGES.every((m) => C.Message.safeParse(m).success)).toBe(true);
    expect(goaPack().messages.at(-1)?.text).toContain('villa');
  });
});

describe('FakeLink', () => {
  it('answers a repeated request_id with the first answer, and refuses a card id already in the room', async () => {
    const link = new FakeLink();
    const a = await link.request('post_message', { trip_id: 't_goa', request_id: 'go_1', card: notice });
    const b = await link.request('post_message', { trip_id: 't_goa', request_id: 'go_1', card: notice });
    expect(b).toEqual(a);
    await expect(link.request('post_message', { trip_id: 't_goa', request_id: 'go_2', card: notice })).rejects.toThrow(/409/);
  });

  it('refuses replace_card for a card it never saw, and keeps the latest version of each card', async () => {
    const link = new FakeLink();
    await expect(link.request('replace_card', { trip_id: 't_goa', card: notice })).rejects.toThrow(/404/);
    await link.request('post_message', { trip_id: 't_goa', request_id: 'go_1', card: notice });
    await link.request('replace_card', { trip_id: 't_goa', card: { ...notice, title: 'Later' } });
    expect(link.card('c_1')?.title).toBe('Later');
    // Every request is recorded, the refused one too (the card updater's tests count a refused replace_card).
    expect(link.sent('replace_card')).toHaveLength(2);
  });

  it('can fail the next request of a method once', async () => {
    const link = new FakeLink();
    link.failNext = { method: 'open_vote', error: new Error('503 unavailable') };
    const vote = { trip_id: 't_goa', request_id: 'go_v', question: 'Which?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] } as const;
    await expect(link.request('open_vote', vote)).rejects.toThrow(/503/);
    await expect(link.request('open_vote', { ...vote, request_id: 'go_v2' })).resolves.toMatchObject({ decision_id: expect.stringMatching(/^d_/) });
  });
});

describe('makeLaneBrain', () => {
  it('gives a Brain with an idempotent desk, a clock that moves only when told, the Goa pack and default switches', async () => {
    const lb = makeLaneBrain({ pool: {} as pg.Pool });
    const item = { id: 'x', tripId: 't_goa', kind: 'task' as const, ref: 'gt_1', dueAt: lb.clock.now(), payload: {} };
    await lb.desk.put(item);
    await lb.desk.put(item);
    expect(lb.desk.items).toHaveLength(1);
    const t0 = lb.clock.now().getTime();
    lb.clock.advance(5_000);
    expect(lb.brain.now().getTime() - t0).toBe(5_000);
    expect((await lb.brain.packs.get('t_goa')).trip.trip_id).toBe('t_goa');
    expect(lb.switches.get('TRAVEL_MODE')).toBe('fake');
    await lb.switches.set('TRAVEL_MODE', 'ixigo');
    expect(lb.brain.switches.get('TRAVEL_MODE')).toBe('ixigo');
    const ctx = lb.ctx({ turnId: 'turn_K' });
    expect(ctx.outcome).toEqual({ spoke: false, silent: false, reactions: 0, posts: [] });
    expect(ctx.cards).toEqual([]);
    expect([ctx.stableId('c_opt'), ctx.stableId('c_opt'), ctx.stableId('go_vote')]).toEqual(['c_opt_turn_K_1', 'c_opt_turn_K_2', 'go_vote_turn_K_1']);
    expect(lb.ctx({ turnId: 'turn_K' }).stableId('c_opt')).toBe('c_opt_turn_K_1');
  });

  it('collects what lanes register with onStop and runs it in reverse order, once, as P1 does', async () => {
    const lb = makeLaneBrain({ pool: {} as pg.Pool });
    const ran: string[] = [];
    lb.brain.onStop(() => {
      ran.push('first');
    });
    lb.brain.onStop(async () => {
      ran.push('second');
    });
    expect(lb.stoppers).toHaveLength(2);
    await lb.stop();
    await lb.stop();
    expect(ran).toEqual(['second', 'first']);
    expect(lb.stoppers).toEqual([]);
  });

  it('eventually waits for a condition, and gives up after its timeout', async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 30);
    await eventually(() => ready);
    expect(ready).toBe(true);
    await expect(eventually(() => false, 50)).rejects.toThrow(/timed out/);
  });

  it('keeps every wake renderer for a kind, and the first line that is not null wins, as P1 does', () => {
    const lb = makeLaneBrain({ pool: {} as pg.Pool });
    const item = { id: 'tap_1', tripId: 't_goa', kind: 'tap' as const, ref: 'c_1', dueAt: lb.clock.now(), payload: { source: 'pay' } };
    lb.context.addWake('tap', (i) => ((i.payload as { source: string }).source === 'options' ? 'options line' : null));
    expect(lb.context.wake(item, goaPack())).toBeNull();
    lb.context.addWake('tap', (i) => ((i.payload as { source: string }).source === 'pay' ? 'pay line' : null));
    expect(lb.context.wake(item, goaPack())).toBe('pay line');
    expect(lb.context.wake({ ...item, payload: { source: 'options' } }, goaPack())).toBe('options line');
  });
});
