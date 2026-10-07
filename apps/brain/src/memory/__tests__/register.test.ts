import type * as C from '@go/contract';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Brain } from '../../app.js';
import { createContext, type ForgottenProvider, type NowProvider } from '../../composer/context.js';
import type { QuickTool } from '../../composer/tools.js';
import { vote } from '../../__tests__/fixtures/goa.js';
import { withSchema } from '../../db/test-db.js';
import type { ToGoHandler } from '../../door/handlers.js';
import type { Message, TripEvent } from '../../door/methods.js';
import { silentLog } from '../../log.js';
import { fakePacks, goaPeople, goaTrip, msg, packOf } from '../../reflex/goa.fixture.js';
import { SocketCallError } from '../../door/rpc.js';
import { codeOnly, sure } from '../../reflex/read.js';
import type { ReflexRead } from '../../reflex/reflex.js';
import type { TripPack } from '../../trips/pack.js';
import { linkLine } from '../decision-lines.js';
import { currentFacts, markForgotten, saveFact } from '../facts.js';
import type { Fold, StoryProvider } from '../fold.js';
import { joinFacts } from '../join-facts.js';
import { reactionRequestId } from '../reactions.js';
import { mirrorLine, recordLines } from '../record.js';
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

function setup(
  tripId: string,
  messages: Message[],
  answers: string[],
  o: { story?: boolean; fail?: (method: string) => Error | null; env?: Record<string, number> } = {},
) {
  const pack: TripPack = packOf(messages, goaTrip({ trip_id: tripId }));
  const handlers = new Map<string, unknown>();
  const tools: QuickTool<any>[] = [];
  const nows: NowProvider[] = [];
  const warnings: string[] = [];
  const stops: Array<() => Promise<void> | void> = [];
  let story: StoryProvider | undefined;
  let forgotten: ForgottenProvider | undefined;
  const link = fakeLink(o.fail ? { fail: o.fail } : {});
  // The fake model goes where buildBrain puts the real one: brain.anthropic.
  const model = scriptedClient(answers);
  const t = manualTimers();
  const context: Record<string, unknown> = { addNow: (p: NowProvider) => nows.push(p), addWake: () => undefined };
  if (o.story !== false) context.setStory = (p: StoryProvider) => { story = p; };
  context.setForgotten = (p: ForgottenProvider) => { forgotten = p; };
  const brain = {
    env: {
      SIDE_MODEL: 'side-test', FOLD_AT_TOKENS: 60_000, STORY_TOKENS: 5_000, CHAT_HARD_CAP_TOKENS: 90_000, NOTES_QUIET_MS: 20_000, FOLD_QUIET_MS: 60_000,
      // registerMemory builds its own Jev client for catch-up; no key, so it never calls out.
      TYPESAFE_BASE_URL: 'https://jev.example', JEV_MODEL: 'jev-1.13.0',
      ...o.env,
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
  return { brain, pack, handlers, tools, nows, warnings, stops, link, model, t, wired, story: () => story, forgotten: () => forgotten };
}
const read = (over: Partial<ReflexRead>): ReflexRead => ({ ...codeOnly({ namesGo: false, secretKinds: [], hasTasks: false, money: false }), ...over });

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

  it('reacts 👍 once a burst could have landed, without the model, with a request_id derived from the message', async () => {
    const m = msg(10, 'p_priya', 'sounds good Go, thanks!');
    const w = setup('t_r5', [m], []);
    await w.wired.onRead(m, read({ reaction: sure('👍') }), w.pack);
    expect(w.link.calls.filter((c) => c.method === 'add_reaction')).toEqual([]);
    w.t.advance(3_000);
    await vi.waitFor(() => expect(w.link.calls.filter((c) => c.method === 'add_reaction')).toHaveLength(1));
    expect(w.link.calls[0]!.params).toMatchObject({ message_id: 'm_0010', emoji: '👍', request_id: expect.stringMatching(/^go_react_[0-9a-f]{24}$/) });
    expect(w.model.prompts).toHaveLength(0);
  });

  it('puts no 👍 on an "ok" that opens a burst to Go: the ask gets Go\'s answer, not a reaction', async () => {
    // Meher's burst in the live drill (t_p1a_572dd322): Jev read "ok" as 👍, and it went on 0.2 s later.
    const at = (s: number) => new Date(Date.parse('2026-10-07T09:00:00Z') + s * 1_000).toISOString();
    const ok = msg(20, 'p_meher', 'ok', { sent_at: at(0) });
    const w = setup('t_r15', [ok], []);
    await w.wired.onRead(ok, read({ reaction: sure('👍') }), w.pack);
    w.pack.messages.push(msg(21, 'p_meher', '@Go one thing', { sent_at: at(1), mentions_go: true }));
    w.t.advance(3_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.link.calls.filter((c) => c.method === 'add_reaction')).toEqual([]);
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

/** Chatter of about 24 estimated tokens a line: 400 lines are about 9,600 tokens. */
const chatter = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) =>
    msg(i + 1, ['p_rahul', 'p_priya', 'p_arjun'][i % 3]!, `line ${i + 1}: chalo beach chalte hain, sunset dekhenge aur phir dinner, kal ka plan bhi`),
  );

describe('the fold in a chat that never goes quiet for a minute', () => {
  const STORY = JSON.stringify({ lines: [{ text: 'The group planned the Goa trip', refs: [1], people: [] }] });

  it('folds right after Go posts once the chat is past FOLD_AT_TOKENS, without waiting for a quiet minute', async () => {
    const w = setup('t_r22', chatter(400), Array<string>(20).fill(STORY), { env: { FOLD_AT_TOKENS: 5_000 } });
    const goes = msg(401, 'go', 'On it!');
    w.pack.messages.push(goes);
    await w.wired.onEvent(ev('t_r22', 401, 'message.created', { message: goes }));
    await vi.waitFor(async () => expect((await w.story()!.get('t_r22')).foldedToSeq).toBeGreaterThan(0));
  });

  it('folds within the longest wait while people keep talking and Go says nothing', async () => {
    const messages = chatter(400);
    // The notes pass runs after each 20 s quiet spell and refuses the story answer; the fold takes one of the rest.
    const w = setup('t_r23', messages, Array<string>(100).fill(STORY), { env: { FOLD_AT_TOKENS: 5_000 } });
    // Someone speaks every 30 s for 12 minutes: never a quiet minute.
    for (let k = 0; k < 24; k += 1) {
      await w.wired.onRead(messages[k]!, read({}), w.pack);
      w.t.advance(30_000);
    }
    await vi.waitFor(async () => expect((await w.story()!.get('t_r23')).foldedToSeq).toBeGreaterThan(0));
  });
});

describe('Forget me in the composer', () => {
  it("hands the composer who was forgotten: after Kabir's forget, P1's real context hides his earlier lines and names him", async () => {
    const w = setup('t_rf1', [
      msg(2, 'p_kabir', "I'll book the cab from Mopa airport for all of us"),
      msg(3, 'p_kabir', "also I'm allergic to peanuts"),
      msg(4, 'p_meher', 'my birthday is on the 7th'),
    ], []);
    await markForgotten(db.pool, 'p_kabir', 't_rf1', 3, new Date('2026-10-07T10:00:00Z'));
    const c = createContext(silentLog);
    c.setForgotten(w.forgotten()!);
    const p = await c.build({ tripId: 't_rf1', pack: w.pack, wake: [], seenSeq: 4, now: new Date('2026-10-07T10:00:00Z'), tz: 'Asia/Kolkata' });
    const text = p.user.map((b) => b.text).join('\n');
    expect(text).toContain('#2 [hidden: someone asked Go to forget them]');
    expect(text).toContain('#3 [hidden: someone asked Go to forget them]');
    expect(text).not.toContain('peanuts');
    expect(text).toContain('#4 Meher: my birthday is on the 7th');
    expect(text).toContain('Kabir used "Forget me in this trip" in the App');
  });
});

describe('a long trip in the prompt after its fold', () => {
  it('folds once past FOLD_AT_TOKENS; the story stands in for the folded chat, which starts at chatFromSeq, under the same 1h markers', async () => {
    const story = JSON.stringify({ lines: [{ text: 'Rahul wants a villa in Anjuna under 8k a head', refs: [7], people: ['p_rahul'] }] });
    // One answer only: a second fold would find the model out of answers.
    const w = setup('t_r24', chatter(400), [story], { env: { FOLD_AT_TOKENS: 8_000 } });
    const goes = msg(401, 'go', 'On it!');
    w.pack.messages.push(goes);
    await w.wired.onEvent(ev('t_r24', 401, 'message.created', { message: goes }));
    const fold = w.story() as Fold;
    await vi.waitFor(async () => expect((await fold.get('t_r24')).foldedToSeq).toBe(200));
    // The oldest half went into the story; the 201 messages left are under the budget, so there is no second fold.
    expect(await fold.maybeFold('t_r24')).toBe('not_needed');
    expect(w.model.prompts).toHaveLength(1);
    expect((await db.pool.query("SELECT fold_no FROM stories WHERE trip_id = 't_r24'")).rows).toEqual([{ fold_no: 1 }]);

    // P1's real context, handed the story the way wireMemory hands it.
    const c = createContext(silentLog);
    c.setStory(fold);
    const p = await c.build({ tripId: 't_r24', pack: w.pack, wake: [], seenSeq: 401, now: new Date('2026-10-07T10:00:00Z'), tz: 'Asia/Kolkata' });
    const hour = { type: 'ephemeral', ttl: '1h' };
    // Breakpoint 1, Go's rules, comes before any of the trip.
    expect(p.system.map((b) => b.cache_control)).toEqual([hour]);
    expect(p.user[0]?.text).toBe('# The trip chat so far, oldest first');
    // The story sits right before the chat chunks and stands in for messages 1 to 200.
    expect(p.user[1]?.text.startsWith('<data source="the story so far">\nThe story so far (messages up to #200;')).toBe(true);
    expect(p.user[1]?.text).toContain('Rahul wants a villa in Anjuna under 8k a head (#7)');
    // The chat starts at chatFromSeq: 201 lines in nine blocks, none of them folded.
    expect(p.user[2]?.text.startsWith('<data source="chat, part 1">\n#201 ')).toBe(true);
    expect(p.chatLines).toBe(201);
    const text = p.user.map((b) => b.text).join('\n');
    for (let n = 1; n <= 200; n += 1) expect(text).not.toContain(`line ${n}:`);
    expect(text).toContain('line 201:');
    // The chat's 1h marker is on the last full block (part 8), after the story and before the blocks that change every turn.
    const marks = p.user.flatMap((b, i) => (b.cache_control ? [i] : []));
    expect(marks).toEqual([9]);
    expect(p.user[9]?.cache_control).toEqual(hour);
    expect(p.user[9]?.text.startsWith('<data source="chat, part 8">')).toBe(true);
    expect(p.user[10]?.text.startsWith('<data source="chat, part 9">')).toBe(true);
  });
});

describe('open lines a vote settles', () => {
  const at = '2026-10-06T10:00:00Z';
  const line = (lineId: string): C.RecordLine => ({
    line_id: lineId, kind: 'open', text: 'Which villa: Casa Mareia, Villa Sol or The Palms?', status: 'active',
    proof: [{ message_id: 'm_0041', person_id: 'p_priya' }], person_ids: ['p_rahul', 'p_priya'], source: 'go', created_at: at, updated_at: at,
  });
  const closed = vote({ decision_id: 'd_villa', status: 'closed', result_index: 1 });
  const doneCalls = (w: ReturnType<typeof setup>) =>
    w.link.calls.filter((c) => c.method === 'update_record_line').map((c) => [c.params['line_id'], c.params['status']]);

  it('decision.closed marks Go\'s open line about that vote done', async () => {
    const w = setup('t_r30', [msg(41, 'p_priya', 'Casa Mareia looks nice')], []);
    w.pack.trip.decisions = [vote({ decision_id: 'd_villa' })];
    await mirrorLine(db.pool, 't_r30', line('r_v30'), 5);
    await linkLine(db.pool, 't_r30', 'r_v30', 'd_villa', w.pack);
    w.pack.trip.decisions = [closed];
    await w.wired.onEvent(ev('t_r30', 9, 'decision.closed', { decision: closed, reason: 'deadline' }));
    expect(doneCalls(w)).toEqual([['r_v30', 'done']]);
  });

  it('the sweep marks it done when the event was missed', async () => {
    const w = setup('t_r31', [msg(41, 'p_priya', 'Casa Mareia looks nice')], []);
    await db.pool.query(`INSERT INTO trips (trip_id) VALUES ('t_r31') ON CONFLICT DO NOTHING`);
    w.pack.trip.decisions = [vote({ decision_id: 'd_villa' })];
    await mirrorLine(db.pool, 't_r31', line('r_v31'), 5);
    await linkLine(db.pool, 't_r31', 'r_v31', 'd_villa', w.pack);
    w.pack.trip.decisions = [closed];
    await w.wired.sweep();
    expect(doneCalls(w)).toEqual([['r_v31', 'done']]);
    // The Server's record.changed would follow; without it the line stays active in the copy and other sweeps here would try again.
    await db.pool.query(`UPDATE record_lines SET status = 'done' WHERE trip_id = 't_r31'`);
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

describe('a trip the Server no longer has', () => {
  it('gets no notes pass and no fold from the sweep, with unread words or heard from lately', async () => {
    const live = msg(90, 'p_priya', 'Friday works');
    const old = msg(91, 'p_arjun', 'Saturday then');
    const w = setup('t_r15', [live], [JSON.stringify({ facts: [], lines: [] })]);
    for (const [trip, m] of [['t_r15', live], ['t_r16', old]] as const) {
      await db.pool.query(`INSERT INTO trips (trip_id) VALUES ($1) ON CONFLICT DO NOTHING`, [trip]);
      await seedMessages(db.pool, trip, [m]);
    }
    // Heard from just before the Server dropped it.
    await w.wired.onRead(old, read({}), packOf([old], goaTrip({ trip_id: 't_r16' })));
    await db.pool.query(`UPDATE trips SET gone_at = now() WHERE trip_id = 't_r16'`);
    w.t.advance(61_000);
    const ran = await w.wired.sweep();
    expect(ran).toContain('t_r15');
    expect(ran).not.toContain('t_r16');
    expect(await w.wired.sweep()).not.toContain('t_r16');
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
