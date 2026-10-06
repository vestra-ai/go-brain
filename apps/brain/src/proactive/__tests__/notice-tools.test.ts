import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAY_NOTHING } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import type { DeskItem } from '../../desk/desk.js';
import { candidate, fakeLink, goaPack, goaTrip, seedTrip, turnCtx } from '../fakes.js';
import { SIMULATED_SOURCE, noticeTools } from '../notice-tools.js';
import { deskId, toPayload, type ProactivePayload } from '../payload.js';
import type { Action, Candidate } from '../policy.js';
import { ProactiveStore } from '../store.js';

const NOW = new Date('2026-10-06T06:30:00Z');
function proItem(c: Candidate, allowed: Action[], forPersonIds: string[] = []): DeskItem {
  const id = deskId(c);
  return { id, tripId: c.tripId, kind: c.source, ref: id, dueAt: NOW, payload: toPayload(c, { kind: 'go', allowed, forPersonIds, counted: true, score: 1, bar: 0 }, 'Asia/Kolkata') };
}
const messageItem: DeskItem = { id: 'msg:1', tripId: 't_goa', kind: 'message', ref: 'm_1', dueAt: NOW, payload: {} };

let db: Awaited<ReturnType<typeof withSchema>>;
let store: ProactiveStore;
const posted: Array<{ p: ProactivePayload; cardId: string }> = [];
beforeAll(async () => {
  db = await withSchema();
  store = new ProactiveStore(db.pool);
  await seedTrip(db.pool, 't_goa');
});
afterAll(async () => {
  await db.drop();
});

const tools = () => noticeTools({ store, now: () => NOW, onPosted: async (p, cardId) => { posted.push({ p, cardId }); } });

describe('post_notice', () => {
  it('pins the simulated delay to Arjun only and labels it, whatever the model asked', async () => {
    const delay = candidate({ dedupeKey: 'sim:flight_status:1', simulated: true });
    await store.add(delay);
    const [post] = tools();
    const link = fakeLink();
    const ctx = turnCtx({ link, pack: goaPack(), wake: [proItem(delay, ['pin'], ['p_arjun'])] });
    const out = await post.run(
      post.input.parse({ tone: 'heads_up', title: 'Your flight is 2 hours late — cab at 9', body: 'Your cab is at 9 pm but you now land at 10:45. Want me to move it to 11?', for_person_ids: ['p_rahul', 'p_arjun'], source_name: 'ixigo' }),
      ctx,
    );
    expect(out).toMatchObject({ posted: true, card_id: 'c_notice_turn_test_1', pinned_for: ['p_arjun'] });
    expect(link.calls).toHaveLength(0); // P1 posts ctx.cards with the turn's message
    const card = ctx.cards[0] as Record<string, unknown>;
    expect(card).toMatchObject({ card_id: 'c_notice_turn_test_1', kind: 'notice', tone: 'heads_up', for_person_ids: ['p_arjun'], source: { name: SIMULATED_SOURCE } });
    expect(String(card.title)).not.toContain('—');
    expect(await store.notice('t_goa', 'c_notice_turn_test_1')).not.toBeNull();
    expect(posted.at(-1)?.cardId).toBe('c_notice_turn_test_1');
  });

  it('pins to the people the bar named when the model forgets to', async () => {
    const c = candidate({ dedupeKey: 'free:1', source: 'timer', topic: 'free_cancel', personIds: ['p_rahul'] });
    const [post] = tools();
    const ctx = turnCtx({ link: fakeLink(), pack: goaPack(), wake: [proItem(c, ['pin'], ['p_rahul'])], turnId: 'turn_free' });
    await post.run(post.input.parse({ tone: 'heads_up', title: 'Free cancellation ends tomorrow', body: 'Villa Sol is free to cancel until Sunday night.' }), ctx);
    expect((ctx.cards[0] as Record<string, unknown>).for_person_ids).toEqual(['p_rahul']);
  });

  it('posts one notice per unprompted turn, however many the model asks for', async () => {
    const c = candidate({ dedupeKey: 'once:1', source: 'timer', topic: 'free_cancel', personIds: ['p_rahul'] });
    const [post] = tools();
    const ctx = turnCtx({ link: fakeLink(), pack: goaPack(), wake: [proItem(c, ['pin'], ['p_rahul'])], turnId: 'turn_once' });
    expect(await post.run(post.input.parse({ tone: 'heads_up', title: 'Free cancellation ends tomorrow', body: 'Villa Sol is free to cancel until Sunday.' }), ctx)).toMatchObject({ posted: true });
    // The refusal is Go's own business: it tells the model to say nothing about it in the chat.
    expect(await post.run(post.input.parse({ tone: 'info', title: 'Also', body: 'One more thing.' }), ctx)).toMatchObject({
      refused: expect.any(String), tell_the_room: SAY_NOTHING,
    });
    expect(ctx.cards).toHaveLength(1);
  });

  it('refuses when the bar allowed only quiet actions', async () => {
    const c = candidate({ dedupeKey: 'quiet:1', source: 'opening', topic: 'chat', personIds: [] });
    const [post] = tools();
    const link = fakeLink();
    const ctx = turnCtx({ link, pack: goaPack(), wake: [proItem(c, ['react'])] });
    const out = await post.run(post.input.parse({ tone: 'info', title: 'Hi', body: 'Hello' }), ctx);
    expect(out).toHaveProperty('refused');
    expect(ctx.cards).toHaveLength(0);
  });

  it('never pins someone who paused Go', async () => {
    const base = goaTrip();
    const trip = goaTrip({ people: base.people.map((p) => (p.person_id === 'p_arjun' ? { ...p, go_paused: true } : p)) });
    const c = candidate({ dedupeKey: 'paused:1' });
    const [post] = tools();
    const link = fakeLink();
    const ctx = turnCtx({ link, pack: goaPack({ trip }), wake: [proItem(c, ['pin'], ['p_arjun'])] });
    const out = await post.run(post.input.parse({ tone: 'heads_up', title: 'Late', body: 'Late flight' }), ctx);
    expect(out).toHaveProperty('refused');
    expect(ctx.cards).toHaveLength(0);
  });

  it('labels a simulated item even in a turn a person woke, and strips paused people there too', async () => {
    const base = goaTrip();
    const trip = goaTrip({ people: base.people.map((p) => (p.person_id === 'p_meher' ? { ...p, go_paused: true } : p)) });
    const delay = candidate({ dedupeKey: 'sim:flight_status:2', simulated: true });
    const [post] = tools();
    const ctx = turnCtx({ link: fakeLink(), pack: goaPack({ trip }), wake: [messageItem, proItem(delay, ['pin'], ['p_arjun'])], turnId: 'turn_mixed' });
    await post.run(post.input.parse({ tone: 'heads_up', title: 'Late flight', body: 'Two hours late.', for_person_ids: ['p_arjun', 'p_meher'] }), ctx);
    const card = ctx.cards[0] as Record<string, unknown>;
    expect(card.source).toEqual({ name: SIMULATED_SOURCE });
    expect(card.for_person_ids).toEqual(['p_arjun']);
  });
});

describe('simulated news', () => {
  it('keeps its pins to the people it names in a turn a person woke, whatever the model asked', async () => {
    const delay = candidate({ dedupeKey: 'sim:flight_status:mixed', simulated: true });
    const [post] = tools();
    const ask = async (forPersonIds?: string[]) => {
      const ctx = turnCtx({ link: fakeLink(), pack: goaPack(), wake: [messageItem, proItem(delay, ['pin'], ['p_arjun'])], turnId: `turn_sim_${forPersonIds?.length ?? 0}` });
      await post.run(post.input.parse({ tone: 'heads_up', title: 'Late flight', body: 'Two hours late.', ...(forPersonIds ? { for_person_ids: forPersonIds } : {}) }), ctx);
      return ctx.cards[0] as Record<string, unknown>;
    };
    expect(await ask()).toMatchObject({ for_person_ids: ['p_arjun'], source: { name: SIMULATED_SOURCE } });
    expect(await ask(['p_rahul', 'p_priya'])).toMatchObject({ for_person_ids: ['p_arjun'] });
  });
});

describe('update_notice', () => {
  it('replaces a notice Go posted, in place', async () => {
    const delay = candidate({ dedupeKey: 'sim:flight_status:3', simulated: true });
    const [post, update] = tools();
    const link = fakeLink();
    const ctx = turnCtx({ link, pack: goaPack(), wake: [proItem(delay, ['pin'], ['p_arjun'])], turnId: 'turn_update' });
    const out = (await post.run(post.input.parse({ tone: 'heads_up', title: 'Late flight', body: 'Two hours late.' }), ctx)) as { card_id: string };
    const ctx2 = turnCtx({ link, pack: goaPack(), wake: [proItem({ ...delay, dedupeKey: 'sim:flight_status:4' }, ['update_card'])] });
    expect(await update.run(update.input.parse({ card_id: out.card_id, body: 'Three hours late now.' }), ctx2)).toMatchObject({ updated: true });
    const replaced = link.of('replace_card')[0]?.card as Record<string, unknown>;
    expect(replaced).toMatchObject({ card_id: out.card_id, body: 'Three hours late now.', source: { name: SIMULATED_SOURCE } });
  });

  it('leaves out someone who paused Go since the notice went out', async () => {
    const c = candidate({ dedupeKey: 'pins:1', source: 'timer', topic: 'free_cancel', personIds: ['p_rahul', 'p_arjun'] });
    const [post, update] = tools();
    const link = fakeLink();
    const ctx = turnCtx({ link, pack: goaPack(), wake: [proItem(c, ['pin'], ['p_rahul', 'p_arjun'])], turnId: 'turn_pins' });
    const out = (await post.run(post.input.parse({ tone: 'heads_up', title: 'Free cancellation ends', body: 'Until Sunday.' }), ctx)) as { card_id: string };
    const base = goaTrip();
    const paused = goaTrip({ people: base.people.map((p) => (p.person_id === 'p_arjun' ? { ...p, go_paused: true } : p)) });
    const ctx2 = turnCtx({ link, pack: goaPack({ trip: paused }), wake: [proItem({ ...c, dedupeKey: 'pins:2' }, ['update_card'])] });
    expect(await update.run(update.input.parse({ card_id: out.card_id, body: 'Until Sunday night.' }), ctx2)).toMatchObject({ updated: true });
    expect(link.of('replace_card').at(-1)?.card).toMatchObject({ for_person_ids: ['p_rahul'], body: 'Until Sunday night.' });
    const allPaused = goaTrip({ people: base.people.map((p) => (['p_arjun', 'p_rahul'].includes(p.person_id) ? { ...p, go_paused: true } : p)) });
    const ctx3 = turnCtx({ link, pack: goaPack({ trip: allPaused }), wake: [proItem({ ...c, dedupeKey: 'pins:3' }, ['update_card'])] });
    expect(await update.run(update.input.parse({ card_id: out.card_id, body: 'x' }), ctx3)).toHaveProperty('refused');
  });

  it('refuses a card it does not know', async () => {
    const [, update] = tools();
    const out = await update.run(update.input.parse({ card_id: 'c_nope', body: 'x' }), turnCtx({ link: fakeLink(), pack: goaPack(), wake: [messageItem] }));
    expect(out).toHaveProperty('refused');
  });
});
