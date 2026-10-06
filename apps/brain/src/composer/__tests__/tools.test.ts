import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeLink, type FakeAnswers } from '../../__tests__/fixtures/fake-link.js';
import { goaSnapshot, msg, vote } from '../../__tests__/fixtures/goa.js';
import { SocketCallError } from '../../door/rpc.js';
import { roomTools } from '../room-tools.js';
import { createTools, makeTurnCtx, type QuickTool } from '../tools.js';

const pack = () => ({ trip: goaSnapshot(), messages: [msg(56, 'p_priya', "I'm veg btw"), msg(57, 'p_arjun', 'can someone book?')], seq: 57 });
function ctxWith(answers: FakeAnswers = {}, turnId = 'turn_T') {
  const f = fakeLink(answers);
  const ctx = makeTurnCtx({ tripId: 't_goa', turnId, link: f.link, pack: pack(), wake: [], signal: new AbortController().signal });
  return { ctx, ...f };
}
const tool = (name: string) => {
  const t = roomTools({ now: () => new Date('2026-10-06T09:00:00Z') }).find((x) => x.name === name);
  if (!t) throw new Error(`no ${name}`);
  return t;
};

describe('the room\'s tools', () => {
  it('react finds "#56" and reacts with a stable request id, tagged with the turn', async () => {
    const { ctx, calls } = ctxWith({ add_reaction: () => ({ seq: 58 }) });
    expect(await tool('react').run({ message_id: '#56', emoji: '✅' }, ctx)).toEqual({ ok: true });
    expect(calls[0]).toEqual({
      method: 'add_reaction',
      params: { request_id: 'go_react_turn_T_1', trip_id: 't_goa', message_id: 'm_56', emoji: '✅' },
      turnId: 'turn_T',
    });
    expect(ctx.outcome.reactions).toBe(1);
  });

  it('react: an unknown message goes back to the model, and an earlier reaction is fine', async () => {
    const { ctx } = ctxWith({ add_reaction: () => { throw new SocketCallError(409, 'already reacted', 'conflict'); } });
    expect(await tool('react').run({ message_id: '#99', emoji: '✅' }, ctx)).toMatchObject({ ok: false });
    expect(await tool('react').run({ message_id: 'm_57', emoji: '👍' }, ctx)).toMatchObject({ ok: true });
    expect(ctx.outcome.reactions).toBe(0);
  });

  it('open_vote opens the vote and puts its card on the turn\'s message', async () => {
    const { ctx, calls } = ctxWith({ open_vote: () => ({ decision_id: 'd_new', seq: 60 }) });
    const r = await tool('open_vote').run(
      { question: 'Where do we stay?', options: [{ label: 'Villa Sol', note: '3 nights, pool' }, { label: 'Casa Azul' }] },
      ctx,
    );
    expect(r).toMatchObject({ ok: true, decision_id: 'd_new' });
    expect(calls[0]?.params).toEqual({
      request_id: 'go_vote_turn_T_1', trip_id: 't_goa', question: 'Where do we stay?', kind: 'choice', anonymous: false,
      options: [{ label: 'Villa Sol', note: '3 nights, pool' }, { label: 'Casa Azul' }],
    });
    expect(ctx.cards).toEqual([{ kind: 'vote', card_id: 'c_vote_turn_T_1', fallback_text: 'Vote: Where do we stay?', decision_id: 'd_new' }]);
  });

  it('open_vote passes every option field through, so a vote made from search results carries the offer', async () => {
    const { ctx, calls } = ctxWith({ open_vote: () => ({ decision_id: 'd_villa', seq: 61 }) });
    const sol = {
      label: 'Villa Sol, Anjuna', image_url: 'https://img.example/villa-sol.jpg', price_minor: 5_420_000, currency: 'INR',
      option_ref: 'ixg_offer_81', note: '3 nights, pool',
    };
    const azul = {
      label: 'Casa Azul, Vagator', image_url: 'https://img.example/casa-azul.jpg', price_minor: 4_980_000, currency: 'INR',
      option_ref: 'ixg_offer_82', note: null,
    };
    // Parsed the way the loop parses the model's arguments: no field is dropped on the way in.
    const args = tool('open_vote').input.parse({ question: 'Which villa?', options: [sol, azul] });
    expect(await tool('open_vote').run(args, ctx)).toMatchObject({ ok: true, decision_id: 'd_villa' });
    expect(calls[0]?.params.options).toEqual([
      sol,
      { label: 'Casa Azul, Vagator', image_url: 'https://img.example/casa-azul.jpg', price_minor: 4_980_000, currency: 'INR', option_ref: 'ixg_offer_82' },
    ]);
  });

  it('open_vote refuses a closing time in the past without asking the Server', async () => {
    const { ctx, calls } = ctxWith({ open_vote: () => ({ decision_id: 'd_new', seq: 60 }) });
    const r = await tool('open_vote').run({ question: 'When?', options: [{ label: 'Fri' }, { label: 'Sat' }], closes_at: '2026-10-06T08:00:00Z' }, ctx);
    expect(r).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('close_vote says who won, fenced; a vote that is not open goes back to the model', async () => {
    const closed = vote({ decision_id: 'd_stay', status: 'closed', voted: 4, tally: [3, 1], result_index: 0, closed_at: '2026-10-06T09:00:00Z' });
    const { ctx } = ctxWith({ close_vote: (p) => {
      if (p.decision_id === 'd_old') throw new SocketCallError(409, 'vote not open', 'conflict');
      return { decision: closed, seq: 61 };
    } });
    expect(await tool('close_vote').run({ decision_id: 'd_stay' }, ctx)).toEqual({
      ok: true, winner: '<data>Villa Sol</data>', tally: ['<data>Villa Sol</data> 3', '<data>Casa Azul</data> 1'], voted: 4, of: 5,
    });
    expect(await tool('close_vote').run({ decision_id: 'd_old' }, ctx)).toEqual({ ok: false, error: 'That vote is not open.' });
  });

  it('update_trip sends only what changes, in the contract\'s shape', async () => {
    const { ctx, calls } = ctxWith({ update_trip: () => ({ seq: 62 }) });
    expect(await tool('update_trip').run({}, ctx)).toEqual({ ok: false, error: 'Nothing to change.' });
    expect(await tool('update_trip').run({ dates: { start: '2026-11-09', end: '2026-11-06' } }, ctx)).toMatchObject({ ok: false });
    expect(await tool('update_trip').run({ destination: 'North Goa', dates: { start: '2026-11-06', end: '2026-11-09' } }, ctx)).toEqual({
      ok: true, changed: ['destination', 'dates'],
    });
    expect(calls[0]?.params).toEqual({
      request_id: 'go_trip_turn_T_1', trip_id: 't_goa', destination: { name: 'North Goa' }, dates: { start: '2026-11-06', end: '2026-11-09' },
    });
  });

  it('stay_silent marks the turn silent', async () => {
    const { ctx } = ctxWith();
    await tool('stay_silent').run({ reason: 'just chatter' }, ctx);
    expect(ctx.outcome.silent).toBe(true);
  });

  it('no tool can pay, book or touch a card', () => {
    const names = roomTools({ now: () => new Date() }).map((t) => t.name).sort();
    expect(names).toEqual(['close_vote', 'open_vote', 'react', 'stay_silent', 'update_trip']);
    for (const n of names) expect(n).not.toMatch(/pay|book|card|spend|charge/);
  });
});

describe('the turn context and the registry', () => {
  it('a rerun of the same turn gets the same ids, in the same order', () => {
    const a = ctxWith({}, 'turn_same').ctx;
    const b = ctxWith({}, 'turn_same').ctx;
    const ids = (c: typeof a) => [c.stableId('go_post'), c.stableId('go_post'), c.stableId('go_react'), c.stableId('c_vote')];
    expect(ids(a)).toEqual(['go_post_turn_same_1', 'go_post_turn_same_2', 'go_react_turn_same_1', 'c_vote_turn_same_1']);
    expect(ids(b)).toEqual(ids(ctxWith({}, 'turn_same').ctx));
  });

  it('a turn with limits carries them; a turn without has neither key', () => {
    const f = fakeLink();
    const base = { tripId: 't_goa', turnId: 'turn_R', link: f.link, pack: pack(), wake: [], signal: new AbortController().signal };
    const limited = makeTurnCtx({ ...base, limits: { tools: ['react', 'post_notice'], mayPostText: false } });
    expect(limited.allowedTools).toEqual(['react', 'post_notice']);
    expect(limited.mayPostText).toBe(false);
    const free = makeTurnCtx({ ...base, limits: null });
    expect('allowedTools' in free).toBe(false);
    expect('mayPostText' in free).toBe(false);
  });

  it('takes snake_case names once each and lists them in name order', () => {
    const tools = createTools();
    const t = (name: string): QuickTool<{ x: string }> => ({ name, description: 'd', input: z.object({ x: z.string() }), run: async () => ({}) });
    tools.register(t('search_stays'));
    tools.register(t('ask_to_pay'));
    expect(() => tools.register(t('search_stays'))).toThrow(/already/);
    expect(() => tools.register(t('Search Stays'))).toThrow(/snake_case/);
    expect(tools.list().map((x) => x.name)).toEqual(['ask_to_pay', 'search_stays']);
  });
});
