import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { withSchema } from '../../db/test-db.js';
import { eventually, makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import { goaPack } from '../../tasks/testing/goa.js';
import { registerTravel } from '../register.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let lb: LaneBrain;
let card: C.Card;

beforeAll(async () => {
  db = await withSchema();
  lb = makeLaneBrain({ pool: db.pool });
  await registerTravel(lb.brain);
  const found = (await lb.tools.run('search_stays', { area: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09', guests: 5 }, lb.ctx({ turnId: 'turn_reg1' }))) as any;
  const ctx = lb.ctx({ turnId: 'turn_reg2' });
  await lb.tools.run('show_options', { results_id: found.results_id, title: 'Villas in North Goa' }, ctx);
  card = C.Card.parse(ctx.cards[0]);
});
afterAll(async () => {
  await db.drop();
});

const tap = (over: Partial<{ tap_id: string; action_id: string; person_id: string; option_id: string }>) => ({
  tap_id: 'tap_1', trip_id: 't_goa', card_id: card.card_id, action_id: 'pick', person_id: 'p_meher', ...over,
});

describe('registerTravel', () => {
  it('sets brain.travel and registers the four travel tools, the two options taps, the tap wake and the image route', async () => {
    expect(lb.brain.travel).toBeDefined();
    expect(lb.tools.list().map((t) => t.name)).toEqual(['search_flights', 'search_stays', 'show_options', 'put_to_vote']);
    expect([...lb.taps.handlers.keys()].sort()).toEqual(['options/pick', 'options/vote']);
    expect(lb.context.wakes.has('tap')).toBe(true);
    expect((await lb.http.inject({ method: 'GET', url: `/img/u${'0'.repeat(32)}.jpg` })).statusCode).toBe(404);
    expect(lb.brain.travel?.simulate).toBeDefined();
  });

  it('"I\'ll take this" puts a tap on the desk for the composer, and the wake line names the person and the option', async () => {
    if (card.kind !== 'options') throw new Error('expected an options card');
    const option = card.options[1]!;
    expect(await lb.taps.tap('options', 'pick', tap({ tap_id: 'tap_p1', option_id: option.option_id }), card)).toEqual({ result: 'done', toast: 'Noted. Go will reply in the room.' });
    const item = lb.desk.of('tap').at(-1)!;
    expect(item).toMatchObject({ id: 'travel:pick:tap_p1', ref: card.card_id, payload: { source: 'options', action: 'pick', optionId: option.option_id, personId: 'p_meher' } });
    const line = lb.context.wake(item, goaPack());
    expect(line).toContain('Meher');
    expect(line).toContain(option.title);
    // A tap from another card is not P4's to read: null, so P5's or P6's renderer (or P1's generic line) answers.
    expect(lb.context.wake({ ...item, payload: { source: 'pay', action: 'approve' } }, goaPack())).toBeNull();
    expect(await lb.taps.tap('options', 'pick', tap({ tap_id: 'tap_p2', option_id: 'opt_gone' }), card)).toEqual({ result: 'refused', toast: 'That option is no longer available' });
  });

  it('"Put it to a vote" opens one vote and posts its card, even when two people tap at the same moment', async () => {
    const [a, b] = await Promise.all([
      lb.taps.tap('options', 'vote', tap({ tap_id: 'tap_v1', action_id: 'vote' }), card),
      lb.taps.tap('options', 'vote', tap({ tap_id: 'tap_v2', action_id: 'vote', person_id: 'p_kabir' }), card),
    ]);
    expect(a.result).toBe('done');
    expect(b.result).toBe('done');
    await eventually(() => lb.link.sent('post_message').some((p) => (p.card as { kind: string }).kind === 'vote'));
    await new Promise((r) => setTimeout(r, 50));
    expect(lb.link.sent('open_vote')).toHaveLength(1);
    expect(await lb.taps.tap('options', 'vote', tap({ tap_id: 'tap_v3', action_id: 'vote' }), card)).toEqual({ result: 'done', toast: 'Already up for a vote' });
  });

  it('closes the ixigo connection through brain.onStop, and has nothing to stop with the fake alone', async () => {
    expect(lb.stoppers).toHaveLength(0);
    const withIxigo = makeLaneBrain({ pool: db.pool, env: { IXIGO_MCP_URL: 'http://127.0.0.1:1/mcp', IXIGO_MCP_TOKEN: 'tok-ixigo-123456' } });
    await registerTravel(withIxigo.brain);
    expect(withIxigo.stoppers).toHaveLength(1);
    // The client connects on its first call, so closing one that never called resolves at once.
    await withIxigo.stop();
    expect(withIxigo.stoppers).toEqual([]);
    await withIxigo.http.close();
  });
});
