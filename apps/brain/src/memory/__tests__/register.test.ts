import type * as C from '@go/contract';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Brain } from '../../app.js';
import type { NowProvider } from '../../composer/context.js';
import type { QuickTool } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import type { ToGoHandler } from '../../door/handlers.js';
import type { Message, TripEvent } from '../../door/methods.js';
import { silentLog } from '../../log.js';
import { fakePacks, goaPeople, goaTrip, msg, packOf } from '../../reflex/goa.fixture.js';
import { SocketCallError } from '../../door/rpc.js';
import { codeOnly, sure } from '../../reflex/read.js';
import type { ReflexRead } from '../../reflex/reflex.js';
import type { TripPack } from '../../trips/pack.js';
import { currentFacts, saveFact } from '../facts.js';
import type { StoryProvider } from '../fold.js';
import { joinFacts } from '../join-facts.js';
import { reactionRequestId } from '../reactions.js';
import { recordLines } from '../record.js';
import { registerMemory, wireMemory } from '../register.js';
import type { Timers } from '../schedule.js';
import { fakeLink, scriptedClient, seedMessages } from './test-kit.js';

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => { db = await withSchema(); });
afterAll(async () => { await db.drop(); });

function manualTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => { const id = next++; due.set(id, { at: now + ms, fn }); return id; },
    clear: (h) => { due.delete(h as number); },
  };
  return {
    timers,
    clock: () => now,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { due.delete(id); t.fn(); }
    },
  };
}

const ev = (tripId: string, seq: number, type: string, data: unknown): TripEvent =>
  ({ event_id: `ev_${tripId}_${seq}`, trip_id: tripId, seq, occurred_at: '2026-10-07T10:00:00Z', type, data }) as unknown as TripEvent;

function setup(tripId: string, messages: Message[], answers: string[], o: { story?: boolean; fail?: (method: string) => Error | null } = {}) {
  const pack: TripPack = packOf(messages, goaTrip({ trip_id: tripId }));
  const handlers = new Map<string, unknown>();
  const tools: QuickTool<any>[] = [];
  const nows: NowProvider[] = [];
  const warnings: string[] = [];
  const stops: Array<() => Promise<void> | void> = [];
  let story: StoryProvider | undefined;
  const link = fakeLink(o.fail ? { fail: o.fail } : {});
  // The fake model goes where buildBrain puts the real one: brain.anthropic.
  const model = scriptedClient(answers);
  const t = manualTimers();
  const context: Record<string, unknown> = { addNow: (p: NowProvider) => nows.push(p), addWake: () => undefined };
  if (o.story !== false) context.setStory = (p: StoryProvider) => { story = p; };
  const brain = {
    env: {
      SIDE_MODEL: 'side-test', FOLD_AT_TOKENS: 60_000, STORY_TOKENS: 5_000, CHAT_HARD_CAP_TOKENS: 90_000, NOTES_QUIET_MS: 20_000, FOLD_QUIET_MS: 60_000,
      // registerMemory builds its own Jev client for catch-up; no key, so it never calls out.
      TYPESAFE_BASE_URL: 'https://jev.example', JEV_MODEL: 'jev-1.13.0',
    },
    anthropic: model,
    pool: db.pool,
    log: { ...silentLog, warn: (_o: object, m?: string) => { warnings.push(m ?? ''); } },
    now: () => new Date('2026-10-07T10:00:00Z'),
    door: { handle: (m: string, h: unknown) => handlers.set(m, h), link },
    tripLog: { onEvent: () => undefined },
    hooks: { onRead: () => undefined },
    packs: fakePacks({ [tripId]: pack }),
    tools: { register: (x: QuickTool<any>) => tools.push(x), list: () => tools },
    context,
    switches: { get: () => '', set: async () => undefined },
    onStop: (fn: () => Promise<void> | void) => {
      stops.push(fn);
    },
  } as unknown as Brain;
  const jev = { ask: async () => ({ ok: false as const, fault: 'timeout' as const, totalMs: 1 }) };
  const wired = wireMemory(brain, { jev, timers: t.timers, clock: t.clock });
  return { brain, pack, handlers, tools, nows, warnings, stops, link, model, t, wired, story: () => story };
}
const read = (over: Partial<ReflexRead>): ReflexRead => ({ ...codeOnly({ namesGo: false, secretKinds: [], hasTasks: false }), ...over });

describe('joinFacts', () => {
  it('turns join answers into facts with plain topics', () => {
    const [rahul, priya, arjun, meher, kabir] = goaPeople();
    expect(joinFacts(rahul!)).toEqual([{ topic: 'from', text: 'From Delhi' }, { topic: 'leaving', text: 'Can leave Fri after 6 pm' }]);
    expect(joinFacts(priya!)).toEqual([{ topic: 'from', text: 'From Delhi' }, { topic: 'food', text: 'Vegetarian' }, { topic: 'seats', text: 'Window seat' }]);
    expect(joinFacts(arjun!).map((f) => f.topic)).toEqual(['from', 'flights', 'arriving']);
    expect(joinFacts(meher!).map((f) => f.topic)).toEqual(['from', 'birthday']);
    expect(joinFacts(kabir!)).toContainEqual({ topic: 'drinks', text: "I don't drink" });
  });
});

describe('wireMemory', () => {
  it('sets brain.memory and registers the handlers, tools, blocks and the story', async () => {
    const w = setup('t_r1', [], []);
    expect(w.brain.memory).toBeDefined();
    expect([...w.handlers.keys()].sort()).toEqual(['catch_up', 'delete_fact', 'forget_person', 'get_person', 'update_person']);
    expect(w.tools.map((x) => x.name)).toEqual(['trip', 'person', 'recall', 'record']);
    expect(w.nows.map((n) => [n.name, n.order])).toEqual([['record', 20], ['people', 22]]);
    expect(w.warnings).toEqual([]);
    // The provider P1's Context.setStory got answers in the shape master §6.3 fixes.
    expect(await w.story()!.get('t_r1')).toEqual({ story: null, chatFromSeq: 1, foldedToSeq: 0, tokens: 0 });
  });

  it('says so, and carries on, when the context cannot take a story', () => {
    const w = setup('t_r2', [], [], { story: false });
    expect(w.warnings).toContain('context has no setStory: long trips are not folded in the prompt');
  });

  it('saves join answers as facts on trip.created, mirrors the record, and keeps a person\'s own words over a join answer', async () => {
    const w = setup('t_r3', [], []);
    const trip = goaTrip({ trip_id: 't_r3', record: [] });
    await w.wired.onEvent(ev('t_r3', 1, 'trip.created', { trip }));
    expect((await currentFacts(db.pool, { personId: 'p_priya', tripId: 't_r3' })).map((f) => [f.topic, f.text, f.messageId]).sort())
      .toEqual([['food', 'Vegetarian', null], ['from', 'From Delhi', null], ['seats', 'Window seat', null]]);
    await saveFact(db.pool, {
      personId: 'p_priya', tripId: 't_r3', topic: 'food', text: 'Eats fish now', messageId: 'm_0040',
      saidAt: new Date('2026-10-07T09:00:00Z'), audience: 'group', source: 'message',
    });
    const priya = { ...goaPeople()[1]!, know: ['Vegetarian'] };
    await w.wired.onEvent(ev('t_r3', 50, 'person.updated', { person: priya, changed: ['know'] }));
    const after = await currentFacts(db.pool, { personId: 'p_priya', tripId: 't_r3' });
    expect(after.map((f) => [f.topic, f.text]).sort()).toEqual([['food', 'Eats fish now'], ['from', 'From Delhi']]);

    const line: C.RecordLine = {
      line_id: 'r_north', kind: 'agreed', text: 'North Goa, not South', status: 'active', proof: [], person_ids: [],
      source: 'go', created_at: '2026-10-07T09:00:00Z', updated_at: '2026-10-07T09:00:00Z',
    };
    await w.wired.onEvent(ev('t_r3', 51, 'record.changed', { line, change: 'added', by: { kind: 'go' } }));
    expect((await recordLines(db.pool, 't_r3')).map((l) => l.line_id)).toEqual(['r_north']);
  });

  it('a cleared join answer takes its history with it: no older answer comes back', async () => {
    const w = setup('t_r14', [], []);
    const priya = (know: string[]) => ({ ...goaPeople()[1]!, know });
    await w.wired.onEvent(ev('t_r14', 1, 'trip.created', { trip: goaTrip({ trip_id: 't_r14', people: [priya(['Vegetarian'])] }) }));
    await w.wired.onEvent(ev('t_r14', 2, 'person.updated', { person: priya(['Vegan']), changed: ['know'] }));
    expect((await currentFacts(db.pool, { personId: 'p_priya', tripId: 't_r14' })).filter((f) => f.topic === 'food').map((f) => f.text)).toEqual(['Vegan']);
    await w.wired.onEvent(ev('t_r14', 3, 'person.updated', { person: priya([]), changed: ['know'] }));
    expect((await currentFacts(db.pool, { personId: 'p_priya', tripId: 't_r14' })).map((f) => f.topic)).toEqual(['from']);
    const left = await db.pool.query(`SELECT text FROM facts WHERE person_id = 'p_priya' AND trip_id = 't_r14' AND topic = 'food'`);
    expect(left.rows).toEqual([]);
  });

  it('drops what a deleted message taught', async () => {
    const w = setup('t_r4', [], []);
    await saveFact(db.pool, {
      personId: 'p_meher', tripId: 't_r4', topic: 'food', text: 'Allergic to peanuts', messageId: 'm_0142',
      saidAt: new Date('2026-10-07T09:00:00Z'), audience: 'group', source: 'message',
    });
    await w.wired.onEvent(ev('t_r4', 150, 'message.deleted', { message_id: 'm_0142' }));
    expect(await currentFacts(db.pool, { personId: 'p_meher', tripId: 't_r4' })).toEqual([]);
  });

  it('reacts 👍 at once, without the model, with a request_id derived from the message', async () => {
    const m = msg(10, 'p_priya', 'sounds good Go, thanks!');
    const w = setup('t_r5', [m], []);
    await w.wired.onRead(m, read({ reaction: sure('👍') }), w.pack);
    await vi.waitFor(() => expect(w.link.calls.filter((c) => c.method === 'add_reaction')).toHaveLength(1));
    expect(w.link.calls[0]!.params).toMatchObject({ message_id: 'm_0010', emoji: '👍', request_id: expect.stringMatching(/^go_react_[0-9a-f]{24}$/) });
    expect(w.model.prompts).toHaveLength(0);
  });

  it('a sure fact + sure ✅ reacts within the hook, before any notes-pass timer, and the notes pass never doubles it', async () => {
    const m = msg(50, 'p_meher', "I'm veg btw");
    const answer = JSON.stringify({ facts: [{ person_id: 'p_meher', topic: 'food', text: 'Vegetarian', message: 50 }], lines: [] });
    const w = setup('t_r10', [m], [answer]);
    await w.wired.onRead(m, read({ fact: sure(true), reaction: sure('✅') }), w.pack);
    // Sent without any timer moving, and no model answer was needed for it.
    const sent = () => w.link.calls.filter((c) => c.method === 'add_reaction');
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]!.params).toMatchObject({ trip_id: 't_r10', message_id: 'm_0050', emoji: '✅', request_id: reactionRequestId('t_r10', 'm_0050', '✅') });
    // The fact check started at once as well; its own ✅ for the same message finds the reaction done and sends nothing.
    await vi.waitFor(async () => expect((await currentFacts(db.pool, { personId: 'p_meher', tripId: 't_r10' })).map((f) => f.text)).toEqual(['Vegetarian']));
    await vi.waitFor(async () => expect((await db.pool.query<{ seq: number }>("SELECT seq FROM notes_cursor WHERE trip_id = 't_r10'")).rows[0]?.seq).toBe(50));
    expect(sent()).toHaveLength(1);
  });

  it('counts a 409 on the instant ✅ as done: the notes pass never sends it again', async () => {
    const m = msg(60, 'p_meher', "I'm veg btw");
    const answer = JSON.stringify({ facts: [{ person_id: 'p_meher', topic: 'food', text: 'Vegetarian', message: 60 }], lines: [] });
    const conflict = (method: string) => (method === 'add_reaction' ? new SocketCallError(409, 'already reacted', 'conflict') : null);
    const w = setup('t_r11', [m], [answer], { fail: conflict });
    await w.wired.onRead(m, read({ fact: sure(true), reaction: sure('✅') }), w.pack);
    await vi.waitFor(() => expect(w.link.calls.filter((c) => c.method === 'add_reaction')).toHaveLength(1));
    // The notes pass saved the fact and reached its own ✅ step, which found the reaction done.
    await vi.waitFor(async () => expect((await currentFacts(db.pool, { personId: 'p_meher', tripId: 't_r11' })).map((f) => f.text)).toEqual(['Vegetarian']));
    await vi.waitFor(async () => expect((await db.pool.query<{ seq: number }>("SELECT seq FROM notes_cursor WHERE trip_id = 't_r11'")).rows[0]?.seq).toBe(60));
    expect(w.link.calls.filter((c) => c.method === 'add_reaction')).toHaveLength(1);
  });

  it('never holds up the trip queue: the hook returns while the instant ✅ is still on its way, and it is sent once', async () => {
    const m = msg(70, 'p_meher', "I'm veg btw");
    const answer = JSON.stringify({ facts: [{ person_id: 'p_meher', topic: 'food', text: 'Vegetarian', message: 70 }], lines: [] });
    const w = setup('t_r12', [m], [answer]);
    // The Server is slow to answer add_reaction until the test lets it.
    let open!: () => void;
    const slow = new Promise<void>((resolve) => { open = resolve; });
    const request = w.link.request.bind(w.link) as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    (w.link as unknown as { request: typeof request }).request = async (method, params) => {
      if (method === 'add_reaction') await slow;
      return request(method, params);
    };
    await w.wired.onRead(m, read({ fact: sure(true), reaction: sure('✅') }), w.pack);
    const sent = () => w.link.calls.filter((c) => c.method === 'add_reaction');
    expect(sent()).toHaveLength(0);
    // The notes pass saves the fact meanwhile; its own ✅ joins the one on its way.
    await vi.waitFor(async () => expect((await currentFacts(db.pool, { personId: 'p_meher', tripId: 't_r12' })).map((f) => f.text)).toEqual(['Vegetarian']));
    open();
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    await vi.waitFor(async () => expect((await db.pool.query<{ seq: number }>("SELECT seq FROM notes_cursor WHERE trip_id = 't_r12'")).rows[0]?.seq).toBe(70));
    expect(sent()).toHaveLength(1);
  });

  it('runs the notes pass at once on a sure fact, and only after a quiet spell otherwise', async () => {
    const fact = msg(20, 'p_meher', "I'm veg btw");
    const chatter = msg(21, 'p_arjun', 'hahaha');
    const answer = JSON.stringify({ facts: [{ person_id: 'p_meher', topic: 'food', text: 'Vegetarian', message: 20 }], lines: [] });
    const w = setup('t_r6', [fact, chatter], [answer, JSON.stringify({ facts: [], lines: [] })]);
    await w.wired.onRead(fact, read({ fact: sure(true) }), w.pack);
    await vi.waitFor(() => expect(w.model.prompts).toHaveLength(1));
    await vi.waitFor(async () => expect((await currentFacts(db.pool, { personId: 'p_meher', tripId: 't_r6' })).map((f) => f.text)).toEqual(['Vegetarian']));
    await vi.waitFor(() => expect(w.link.calls.filter((c) => c.method === 'add_reaction').map((c) => c.params.emoji)).toEqual(['✅']));

    w.pack.messages.push(msg(22, 'p_kabir', 'scuba on Saturday?'));
    await w.wired.onRead(w.pack.messages[2]!, read({}), w.pack);
    w.t.advance(19_000);
    expect(w.model.prompts).toHaveLength(1);
    w.t.advance(1_000);
    await vi.waitFor(() => expect(w.model.prompts).toHaveLength(2));
  });

  it('reads the turn\'s new lines two seconds after Go posts', async () => {
    const mine = msg(30, 'p_priya', 'I can only do Friday night');
    const goes = msg(31, 'go', 'Noted, Friday night it is.');
    const w = setup('t_r7', [mine, goes], [JSON.stringify({ facts: [], lines: [] })]);
    await w.wired.onEvent(ev('t_r7', 31, 'message.created', { message: goes }));
    w.t.advance(1_500);
    expect(w.model.prompts).toHaveLength(0);
    w.t.advance(600);
    await vi.waitFor(() => expect(w.model.prompts).toHaveLength(1));
    expect(w.model.prompts[0]!.user).toContain('#30 [person Priya | p_priya]: I can only do Friday night');
    // The side pass ran on brain.anthropic with SIDE_MODEL, not on a client of its own.
    expect(w.model.prompts[0]!).toMatchObject({ model: 'side-test', maxTokens: 1_500 });
  });

  it('stop() clears every quiet and after-post timer: nothing runs after Go stops', async () => {
    const m = msg(40, 'p_kabir', 'scuba on Saturday?');
    const goes = msg(41, 'go', 'Two places do Saturday dives.');
    const w = setup('t_r8', [m, goes], [JSON.stringify({ facts: [], lines: [] })]);
    await w.wired.onRead(m, read({}), w.pack);
    await w.wired.onEvent(ev('t_r8', 41, 'message.created', { message: goes }));
    w.wired.stop();
    w.t.advance(120_000);
    expect(w.model.prompts).toHaveLength(0);
  });
});

describe('the 5-minute sweep after a restart', () => {
  it('finds a trip with unread words in the database, with nothing heard since the restart', async () => {
    const m = msg(80, 'p_priya', 'I can only do Friday night');
    const w = setup('t_r13', [m], [JSON.stringify({ facts: [], lines: [] })]);
    await db.pool.query(`INSERT INTO trips (trip_id) VALUES ('t_r13') ON CONFLICT DO NOTHING`);
    await seedMessages(db.pool, 't_r13', [m]);
    await w.wired.sweep();
    await vi.waitFor(() => expect(w.model.prompts).toHaveLength(1));
    expect(w.model.prompts[0]!.user).toContain('#80 [person Priya | p_priya]: I can only do Friday night');
    await vi.waitFor(async () => expect((await db.pool.query<{ seq: number }>("SELECT seq FROM notes_cursor WHERE trip_id = 't_r13'")).rows[0]?.seq).toBe(80));
  });
});

describe('registerMemory', () => {
  it('hands brain.onStop one stopper that clears the 5-minute sweep and the quiet timers', async () => {
    const w = setup('t_r9', [], []);
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    await registerMemory(w.brain);
    expect(w.stops).toHaveLength(1);
    await w.stops[0]!();
    expect(cleared).toHaveBeenCalled();
    cleared.mockRestore();
  });
});

describe('catch_up once Task 13 lands', () => {
  it('answers what the person missed, not the empty answer Task 12 left in its place', async () => {
    const mention = msg(171, 'p_priya', 'Meher are you okay with a 6 am start?', { mentions: ['p_meher'] });
    const w = setup('t_r20', [mention], []);
    const catchUp = w.handlers.get('catch_up') as ToGoHandler<'catch_up'>;
    const res = await catchUp({ trip_id: 't_r20', person_id: 'p_meher', since: '2026-10-05T05:00:00Z' }, { instance: 'server-1', frameId: 'gs_3' });
    expect(res.items).toEqual([{ kind: 'needs_you', text: 'Priya mentioned you: Meher are you okay with a 6 am start?', message_id: 'm_0171' }]);
  });
});
