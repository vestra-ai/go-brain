import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeAnthropic, type Script } from '../../__tests__/fixtures/fake-anthropic.js';
import { goaSnapshot, msg } from '../../__tests__/fixtures/goa.js';
import { createBudget, type Budget } from '../../budget.js';
import { withSchema } from '../../db/test-db.js';
import { createDesk, type DeskItem } from '../../desk/desk.js';
import type { Message } from '../../door/methods.js';
import { createServerLink } from '../../door/server-link.js';
import { reactOnce } from '../../memory/reactions.js';
import { silentLog } from '../../log.js';
import type { TripPack } from '../../trips/pack.js';
import { createContext, type TurnLimits } from '../context.js';
import { roomTools } from '../room-tools.js';
import { createSpeak } from '../speak.js';
import { createTools, type QuickTool } from '../tools.js';
import { FakeIxigoStore } from '../../travel/fake-ixigo/data.js';
import { createImages } from '../../travel/images.js';
import { createTravelLayer } from '../../travel/layer.js';
import { createIxigoLogin, HELLO_LINE } from '../../travel/login.js';
import { createFakeTravel } from '../../travel/mcp-travel.js';
import { createResultsStore } from '../../travel/results.js';
import { travelTools } from '../../travel/tools.js';
import { createComposer, logTurn, OVER_BUDGET, TROUBLE } from '../turn.js';
import { ASK_HOW_MUCH, renderMessageWake, renderSetupWake, renderTripChangeWake } from '../wakes.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

let rooms = 0;
/** A composer on a real ServerLink (so go_requests is real) whose socket answers like the Server. */
function room(o: {
  messages: Message[];
  script: Script;
  claimNew?: (tripId: string, turnId: string) => Promise<DeskItem[]>;
  release?: (turnId: string, ids: string[]) => Promise<void>;
  limits?: (wake: DeskItem[]) => TurnLimits | null;
  budget?: Budget;
  /** More quick tools, as a lane would register them. */
  extraTools?: QuickTool<any>[];
}) {
  const tripId = `t_turn_${++rooms}`;
  const calls: Array<{ method: string; params: any }> = [];
  const notes: Array<{ method: string; params: any }> = [];
  const released: string[] = [];
  const link = createServerLink({ pool: db.pool, log: silentLog, timeoutMs: 1_000 });
  const answers: Record<string, () => Record<string, unknown>> = {
    post_message: () => ({ message_id: `m_go_${calls.length}`, seq: 100 + calls.length }),
    add_reaction: () => ({ seq: 100 + calls.length }),
    remove_reaction: () => ({ seq: 100 + calls.length }),
    open_vote: () => ({ decision_id: 'd_first', seq: 100 + calls.length }),
  };
  link.attach({
    id: 's1',
    instance: 'test',
    send: (frame) => {
      const f = JSON.parse(frame);
      if (f.id === undefined) {
        notes.push({ method: f.method, params: f.params });
        return;
      }
      calls.push({ method: f.method, params: f.params });
      const answer = answers[f.method];
      setImmediate(() =>
        link.onAnswer(answer ? { kind: 'result', id: f.id, result: answer() } : { kind: 'error', id: f.id, error: { code: -32601, message: 'not here' } }),
      );
    },
  });
  const pack: TripPack = { trip: goaSnapshot({ trip_id: tripId }), messages: [...o.messages], seq: 100 };
  const tools = createTools();
  for (const t of roomTools({ now: () => new Date(), pool: db.pool })) tools.register(t);
  for (const t of o.extraTools ?? []) tools.register(t);
  const context = createContext(silentLog);
  context.addWake('message', renderMessageWake);
  context.addWake('trip_change', renderTripChangeWake);
  context.addWake('setup', renderSetupWake);
  if (o.limits) context.addTurnRules(o.limits);
  const model = fakeAnthropic(o.script);
  const speak = createSpeak({ pool: db.pool, link, now: () => new Date() });
  const composer = createComposer({
    pool: db.pool, log: silentLog, now: () => new Date(), link,
    packs: { get: async () => pack, invalidate: () => undefined },
    tools, context, speak,
    client: model.client, model: 'claude-sonnet-5-5', claimNew: o.claimNew ?? (async () => []),
    release: o.release ?? (async (_turnId, ids) => { released.push(...ids); }),
    ...(o.budget ? { budget: o.budget } : {}),
  });
  return { tripId, calls, notes, link, model, composer, pack, speak, released, context, posts: () => calls.filter((c) => c.method === 'post_message') };
}

const item = (tripId: string, m: Message, namesGo: boolean): DeskItem => ({
  id: `msg:${tripId}:${m.message_id}`, tripId, kind: 'message', ref: m.message_id, dueAt: new Date(), payload: { messageId: m.message_id, seq: m.seq, namesGo },
});

async function turn(r: ReturnType<typeof room>, items: DeskItem[], turnId = `turn_${r.tripId}`, attempt = 1) {
  await db.pool.query('insert into trips (trip_id) values ($1) on conflict do nothing', [r.tripId]);
  await r.composer.runTurn({ tripId: r.tripId, turnId, items, attempt });
}

describe('a composer turn', () => {
  it('"@Go ..." gets one post in the model\'s words, cleaned, and the turn is written down', async () => {
    const ask = msg(3, 'p_arjun', '@Go flights Delhi to Goa Friday evening?');
    const r = room({ messages: [msg(2, 'p_priya', 'Goa in November!'), ask], script: [{ text: 'Friday evening — three flights after 6 pm, checking fares now.' }] });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.posts()).toHaveLength(1);
    expect(r.posts()[0]?.params).toEqual({
      request_id: `go_post_turn_${r.tripId}_1`, trip_id: r.tripId, text: 'Friday evening, three flights after 6 pm, checking fares now.',
    });
    expect(r.notes.map((x) => x.params.on)).toEqual([true, false]);
    const { rows } = await db.pool.query('select * from turns where turn_id = $1', [`turn_${r.tripId}`]);
    expect(rows[0]).toMatchObject({ outcome: 'spoke', rounds: 1, input_tokens: 100, output_tokens: 20, woke_for: ['message'] });
    for (const k of ['typing_at', 'first_token_at', 'posted_at', 'ended_at']) expect(rows[0][k]).toBeInstanceOf(Date);
    const seen = await db.pool.query('select composer_seen_seq from trips where trip_id = $1', [r.tripId]);
    expect(seen.rows[0].composer_seen_seq).toBe(3);
    expect(r.model.bodies[0].messages[0].content.at(-1).text).toContain('#3 Arjun: @Go flights Delhi to Goa Friday evening?');
  });

  it('chatter: the model stays silent, nothing is posted and typing never shows', async () => {
    const lol = msg(4, 'p_meher', 'lol');
    const r = room({ messages: [lol], script: [{ tools: [{ name: 'stay_silent', input: { reason: 'chatter' } }] }] });
    await turn(r, [item(r.tripId, lol, false)]);
    expect(r.posts()).toEqual([]);
    expect(r.notes).toEqual([]);
    const { rows } = await db.pool.query('select outcome from turns where turn_id = $1', [`turn_${r.tripId}`]);
    expect(rows[0].outcome).toBe('silent');
  });

  it('the greeting: hello only, and the model is not told to open a vote', async () => {
    const r = room({ messages: [], script: [{ text: 'Hi all, I am Go! I can find stays, run votes and keep the plan.' }] });
    await turn(r, [{ id: `setup:${r.tripId}:greet`, tripId: r.tripId, kind: 'setup', ref: 'greet', dueAt: new Date(), payload: {} }]);
    expect(r.calls.map((c) => c.method)).toEqual(['post_message']);
    expect(r.posts()[0]?.params).toMatchObject({ text: 'Hi all, I am Go! I can find stays, run votes and keep the plan.' });
    expect(r.posts()[0]?.params.card).toBeUndefined();
    const why = r.model.bodies[0].messages[0].content.at(-2).text;
    expect(why).toContain('you just joined this trip');
    expect(why).not.toMatch(/open_vote|first vote/);
    expect(r.notes).toEqual([]);
  });

  it('the first ask lands with the hello: one turn reads both, is told to answer the ask first, and is not told to vote', async () => {
    const ask = msg(2, 'p_priya', '@Go is there a ferry from Panjim to Divar island?');
    const r = room({ messages: [ask], script: [{ text: 'Yes, the Ribandar ferry goes to Divar all day. Hi all, I am Go!' }] });
    await turn(r, [
      { id: `setup:${r.tripId}:greet`, tripId: r.tripId, kind: 'setup', ref: 'greet', dueAt: new Date(), payload: {} },
      item(r.tripId, ask, true),
    ]);
    expect(r.calls.map((c) => c.method)).toEqual(['post_message']);
    const why = r.model.bodies[0].messages[0].content.at(-2).text;
    expect(why).toContain('you just joined this trip');
    expect(why).toContain('answer that first');
    expect(why).toContain('message #2 from Priya, it names you');
    expect(why).not.toMatch(/open_vote|first vote/);
  });

  it('cites a message by its number: the number leaves the words, and the post replies to that message', async () => {
    const veg = msg(2, 'p_meher', "I'm veg btw");
    const ask = msg(3, 'p_priya', "@Go what can't Meher eat?");
    const r = room({ messages: [veg, ask], script: [{ text: 'Meher is vegetarian, so no seafood shacks. Meher said so in #2.' }] });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.posts()[0]?.params).toMatchObject({ text: 'Meher is vegetarian, so no seafood shacks. Meher said so.', reply_to: veg.message_id });
  });

  it('a number that is no message in the trip leaves the words too, and no proof is made up for it', async () => {
    const ask = msg(3, 'p_priya', "@Go what can't Meher eat?");
    const r = room({ messages: [ask], script: [{ text: 'Meher is vegetarian. Meher said so in #99.' }] });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.posts()[0]?.params.text).toBe('Meher is vegetarian. Meher said so.');
    expect(r.posts()[0]?.params.reply_to).toBeUndefined();
  });

  // GO-TEAM-ASKS-REV4 A4 (the Server team, 10 Oct): the App's own lines are a record, and Go never replies to one, even
  // when its words cite it as the proof.
  it("never replies to one of the App's own lines, even when Go's words cite it", async () => {
    const line = msg(2, null, 'Priya added Airport cab · ₹1,700 · split 4 ways', { author: { kind: 'system' } });
    const ask = msg(3, 'p_arjun', '@Go did Priya add the cab?');
    const r = room({ messages: [line, ask], script: [{ text: 'Yes, Priya added the airport cab. The App says so in #2.' }] });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.posts()[0]?.params.text).toBe('Yes, Priya added the airport cab. The App says so.');
    expect(r.posts()[0]?.params.reply_to).toBeUndefined();
  });

  it('the pre-post check: a message that lands while Go writes joins the same turn', async () => {
    const ask = msg(3, 'p_arjun', '@Go flights Friday?');
    const more = msg(5, 'p_kabir', 'also Saturday?');
    let claimed = false;
    const r = room({
      messages: [ask],
      script: [{ text: 'Friday: three flights after 6 pm.' }, { text: 'Friday has three flights after 6 pm, Saturday has two.' }],
      claimNew: async (tripId) => {
        if (claimed) return [];
        claimed = true;
        r.pack.messages.push(more);
        return [item(tripId, more, false)];
      },
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(2);
    expect(r.model.bodies[0].messages[0].content.at(-1).text).not.toContain('#5 ');
    const fold = r.model.bodies[1].messages.at(-1).content[0].text;
    expect(fold).toContain('# New while you were writing');
    expect(fold).toContain('#5 Kabir: also Saturday?');
    expect(r.posts()).toHaveLength(1);
    expect(r.posts()[0]?.params.text).toBe('Friday has three flights after 6 pm, Saturday has two.');
    const seen = await db.pool.query('select composer_seen_seq from trips where trip_id = $1', [r.tripId]);
    expect(seen.rows[0].composer_seen_seq).toBe(5);
  });

  it('an ask that ends at once ("...?") gets no wait, and the same person\'s next line, landing before the post, joins that turn', async () => {
    const ask = msg(3, 'p_arjun', '@Go flights to Goa?');
    const more = msg(5, 'p_arjun', 'from Delhi');
    let claimed = false;
    const r = room({
      messages: [ask],
      script: [{ text: 'Flights to Goa: three on Friday.' }, { text: 'From Delhi to Goa: three flights on Friday.' }],
      claimNew: async (tripId) => {
        if (claimed) return [];
        claimed = true;
        r.pack.messages.push(more);
        return [item(tripId, more, false)];
      },
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(2);
    expect(r.model.bodies[1].messages.at(-1).content[0].text).toContain('#5 Arjun: from Delhi');
    expect(r.posts().map((p) => p.params.text)).toEqual(['From Delhi to Goa: three flights on Friday.']);
  });

  it('the pre-post check never reads a message twice: one the prompt already held runs no extra round', async () => {
    const ask = msg(3, 'p_arjun', '@Go is the villa free?');
    // In the pack when the prompt was built, its desk item claimed only at the pre-post check.
    const early = msg(4, 'p_kabir', '@Go and pets?');
    let claimed = false;
    const r = room({
      messages: [ask, early],
      script: [{ text: 'The villa is free, and pets are welcome.' }, { text: 'never asked' }],
      claimNew: async (tripId) => {
        if (claimed) return [];
        claimed = true;
        return [item(tripId, early, true)];
      },
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(1);
    expect(r.model.bodies[0].messages[0].content.at(-1).text).toContain('#4 Kabir: @Go and pets?');
    expect(r.posts().map((p) => p.params.text)).toEqual(['The villa is free, and pets are welcome.']);
    const seen = await db.pool.query('select composer_seen_seq from trips where trip_id = $1', [r.tripId]);
    expect(seen.rows[0].composer_seen_seq).toBe(4);
    // It names Go but was no reason this turn woke: it goes back on the desk for a turn of its own.
    expect(r.released).toEqual([`msg:${r.tripId}:m_4`]);
  });

  it('a budget that runs out before the extra round: the answer round 1 paid for still goes out, and the unread ask hears the limit', async () => {
    const ask = msg(3, 'p_arjun', '@Go flights Delhi to Goa Friday?');
    const more = msg(5, 'p_kabir', '@Go and hotels?');
    let claimed = false;
    // claude-sonnet-5-5 at $2 per million input tokens: round 1's 600,000 cost $1.20, past the $1 cap.
    const budget = createBudget({ pool: db.pool, now: () => new Date(), capUsd: 1, log: silentLog });
    const r = room({
      messages: [ask],
      script: [{ text: 'Three flights after 6 pm on Friday.', usage: { input_tokens: 600_000 } }, { text: 'never asked' }],
      budget,
      claimNew: async (tripId) => {
        if (claimed) return [];
        claimed = true;
        r.pack.messages.push(more);
        return [item(tripId, more, true)];
      },
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(1);
    expect(r.posts().map((p) => p.params.text)).toEqual(['Three flights after 6 pm on Friday.', OVER_BUDGET]);
    // The extra line was never read: it stays new for the next turn.
    const seen = await db.pool.query('select composer_seen_seq from trips where trip_id = $1', [r.tripId]);
    expect(seen.rows[0].composer_seen_seq).toBe(3);
    const { rows } = await db.pool.query('select outcome, rounds from turns where turn_id = $1', [`turn_${r.tripId}`]);
    expect(rows[0]).toMatchObject({ outcome: 'spoke', rounds: 1 });
  });

  it('with no answer at all (the first hold does not fit), someone who asked hears the limit line, and the model is never called', async () => {
    const ask = msg(3, 'p_arjun', '@Go flights Friday?');
    // Room is left today (allows), but less than one call's hold.
    const budget = createBudget({ pool: db.pool, now: () => new Date(), capUsd: 0.000_001, log: silentLog });
    const r = room({ messages: [ask], script: [{ text: 'never asked' }], budget });
    expect(budget.allows()).toBe(true);
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(0);
    expect(r.posts().map((p) => p.params.text)).toEqual([OVER_BUDGET]);
  });

  it('typing goes off when the turn ends, also when the message that named Go was pulled in, or the turn posted', async () => {
    const ask = msg(3, 'p_arjun', '@Go and flights?');
    let claimed = false;
    const pulled = room({
      messages: [],
      // The fold round ends silent, so only the pulled-in message can turn typing off.
      script: [{ text: 'Hi all, I am Go!' }, { tools: [{ name: 'stay_silent', input: { reason: 'nothing to add' } }] }],
      claimNew: async (tripId) => {
        if (claimed) return [];
        claimed = true;
        pulled.pack.messages.push(ask);
        pulled.speak.typingOn(tripId); // what intake does for a message that names Go
        return [item(tripId, ask, true)];
      },
    });
    await turn(pulled, [{ id: `setup:${pulled.tripId}:greet`, tripId: pulled.tripId, kind: 'setup', ref: 'greet', dueAt: new Date(), payload: {} }]);
    expect(pulled.posts()).toEqual([]);
    expect(pulled.notes.map((x) => x.params.on)).toEqual([true, false]);

    const hey = msg(4, 'p_meher', 'go team!');
    const posted = room({ messages: [hey], script: [{ text: 'Let us go!' }] });
    posted.speak.typingOn(posted.tripId);
    await turn(posted, [item(posted.tripId, hey, false)]);
    expect(posted.posts()).toHaveLength(1);
    expect(posted.notes.map((x) => x.params.on)).toEqual([true, false]);
  });

  it('the pre-post check never sends an empty assistant message when the last round wrote nothing', async () => {
    const ask = msg(3, 'p_arjun', '@Go is the villa free?');
    const more = msg(5, 'p_kabir', 'and pets?');
    let claimed = false;
    const r = room({
      messages: [ask],
      script: [
        { text: 'Checking the villa now.', tools: [{ name: 'react', input: { message_id: '#3', emoji: '👀' } }] },
        {},
        { text: 'The villa is free, and pets are welcome.' },
      ],
      claimNew: async (tripId) => {
        if (claimed) return [];
        claimed = true;
        r.pack.messages.push(more);
        return [item(tripId, more, false)];
      },
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(3);
    const sent = r.model.bodies[2].messages as Array<{ role: string; content: unknown[] }>;
    for (const m of sent) expect(m.content.length).toBeGreaterThan(0);
    expect(sent[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Checking the villa now.' }] });
    expect(r.posts()[0]?.params.text).toBe('The villa is free, and pets are welcome.');
  });

  it('a rerun after the message went out posts nothing more and asks the model nothing', async () => {
    const ask = msg(3, 'p_arjun', '@Go hi');
    const r = room({ messages: [ask], script: [{ text: 'Hey!' }] });
    await turn(r, [item(r.tripId, ask, true)]);
    await turn(r, [item(r.tripId, ask, true)], `turn_${r.tripId}`, 2);
    expect(r.posts()).toHaveLength(1);
    expect(r.model.bodies).toHaveLength(1);
  });

  it('a crash before posting: the rerun repeats the same request ids, so nothing is done twice', async () => {
    const ask = msg(3, 'p_arjun', '@Go is the villa pet friendly?');
    const react = { name: 'react', input: { message_id: '#3', emoji: '👀' } };
    const r = room({ messages: [ask], script: [{ tools: [react] }, { throws: new Error('overloaded') }, { tools: [react] }, { text: 'Yes, pets are welcome.' }] });
    await expect(turn(r, [item(r.tripId, ask, true)])).rejects.toThrow('overloaded');
    const failed = await db.pool.query('select outcome, error from turns where turn_id = $1', [`turn_${r.tripId}`]);
    expect(failed.rows[0].outcome).toBe('failed');
    expect(failed.rows[0].error).toContain('overloaded');
    expect(r.notes.at(-1)?.params.on).toBe(false);
    await turn(r, [item(r.tripId, ask, true)], `turn_${r.tripId}`, 2);
    expect(r.calls.filter((c) => c.method === 'add_reaction')).toHaveLength(1);
    expect(r.posts()).toHaveLength(1);
  });

  it('tells the lanes once the turn is over, with the messages it handled, pulled ones too; a failed attempt is not the end', async () => {
    const ask = msg(3, 'p_arjun', '@Go flights Friday?');
    const more = msg(5, 'p_kabir', 'also Saturday?');
    let claimed = false;
    const r = room({
      messages: [ask],
      script: [{ throws: new Error('overloaded') }, { text: 'Friday: three flights after 6 pm.' }, { text: 'Friday has three flights after 6 pm, Saturday has two.' }],
      claimNew: async (tripId) => {
        if (claimed) return [];
        claimed = true;
        r.pack.messages.push(more);
        return [item(tripId, more, false)];
      },
    });
    const ended: unknown[] = [];
    r.context.addTurnEnd((t) => ended.push(t));
    await expect(turn(r, [item(r.tripId, ask, true)])).rejects.toThrow('overloaded');
    expect(ended).toEqual([]);
    await turn(r, [item(r.tripId, ask, true)], `turn_${r.tripId}`, 2);
    expect(ended).toEqual([{ tripId: r.tripId, turnId: `turn_${r.tripId}`, messageIds: ['m_3', 'm_5'] }]);
  });

  it('a message pulled in is part of what woke the turn for the next round\'s tools: "I will pay" said as a vote closes is that person\'s ask', async () => {
    const pay = msg(5, 'p_rahul', '@Go Villa Sol it is, I will pay for it');
    const woke: string[][] = [];
    const probe: QuickTool<Record<string, never>> = {
      name: 'what_woke', description: 'Says what woke this turn.', input: z.object({}),
      run: async (_a, ctx) => {
        woke.push(ctx.wake.map((w) => (w.kind === 'message' ? w.ref : w.kind)));
        return { ok: true };
      },
    };
    const call = { name: 'what_woke', input: {} };
    let claimed = false;
    const r = room({
      messages: [],
      extraTools: [probe],
      script: [{ tools: [call] }, { text: 'Villa Sol won, 4 to 1.' }, { tools: [call] }, { text: 'Rahul is booking it.' }],
      claimNew: async (tripId) => {
        if (claimed) return [];
        claimed = true;
        r.pack.messages.push(pay);
        return [item(tripId, pay, true)];
      },
    });
    const closed: DeskItem = {
      id: `change:${r.tripId}:ev_1`, tripId: r.tripId, kind: 'trip_change', ref: 'decision:d_villa', dueAt: new Date(),
      payload: { type: 'decision.closed', decisionId: 'd_villa', reason: 'all_voted' },
    };
    const ended: unknown[] = [];
    r.context.addTurnEnd((t) => ended.push(t));
    await turn(r, [closed]);
    expect(woke).toEqual([['trip_change'], ['trip_change', 'm_5']]);
    expect(r.posts()).toHaveLength(1);
    expect(ended).toEqual([{ tripId: r.tripId, turnId: `turn_${r.tripId}`, messageIds: ['m_5'] }]);
  });

  it('giving up ends the turn for the lanes too', async () => {
    const ask = msg(3, 'p_arjun', '@Go hello?');
    const r = room({ messages: [ask], script: [] });
    const ended: unknown[] = [];
    r.context.addTurnEnd((t) => ended.push(t));
    await r.composer.giveUp({ tripId: r.tripId, turnId: 'turn_g', items: [item(r.tripId, ask, true)], attempt: 3 });
    expect(ended).toEqual([{ tripId: r.tripId, turnId: 'turn_g', messageIds: ['m_3'] }]);
  });

  it('giving up: one calm message, only when someone was waiting', async () => {
    const ask = msg(3, 'p_arjun', '@Go hello?');
    const r = room({ messages: [ask], script: [] });
    const t = { tripId: r.tripId, turnId: `turn_${r.tripId}`, items: [item(r.tripId, ask, true)], attempt: 3 };
    await r.composer.giveUp(t);
    await r.composer.giveUp(t);
    expect(r.posts()).toHaveLength(1);
    expect(r.posts()[0]?.params).toMatchObject({ request_id: `go_trouble_turn_${r.tripId}`, text: TROUBLE });
    const quiet = room({ messages: [], script: [] });
    await quiet.composer.giveUp({
      tripId: quiet.tripId, turnId: 'turn_quiet', attempt: 3,
      items: [{ id: 'g', tripId: quiet.tripId, kind: 'setup', ref: 'greet', dueAt: new Date(), payload: {} }],
    });
    expect(quiet.posts()).toEqual([]);
  });

  it('replies to the message that named Go when others spoke after it', async () => {
    const ask = msg(3, 'p_arjun', '@Go what time is check-in?');
    const after = msg(4, 'p_meher', 'and checkout?');
    const r = room({ messages: [ask, after], script: [{ text: 'Check-in is at 2 pm.' }] });
    await turn(r, [item(r.tripId, ask, true), item(r.tripId, after, false)]);
    expect(r.posts()[0]?.params.reply_to).toBe('m_3');
  });

  it('a turn Go woke for on its own keeps its limits: no text when it may not post, but its card still goes', async () => {
    const r = room({
      messages: [msg(3, 'p_arjun', 'villa or resort, guys?')],
      limits: (wake) => (wake.every((w) => w.kind === 'opening') ? { tools: ['open_vote'], mayPostText: false } : null),
      script: [
        {
          tools: [
            { name: 'open_vote', input: { question: 'Villa or resort?', options: [{ label: 'Villa' }, { label: 'Resort' }], line: 'Villa or resort? Tap your pick.' } },
            { name: 'update_trip', input: { stay: 'resort' } },
          ],
        },
        { text: 'Opened a vote for you all!' },
      ],
    });
    await turn(r, [{ id: `opening:${r.tripId}:stay`, tripId: r.tripId, kind: 'opening', ref: 'stay', dueAt: new Date(), payload: {} }]);
    expect(r.calls.map((c) => c.method)).toEqual(['open_vote', 'post_message']);
    expect(r.posts()[0]?.params.text).toBeUndefined();
    expect(r.posts()[0]?.params.card).toMatchObject({ kind: 'vote', decision_id: 'd_first' });
    const refused = r.model.bodies[1].messages[2].content.find((b: { is_error?: boolean }) => b.is_error);
    expect(refused.content).toContain('update_trip is not allowed this turn');
    // The definitions sent are the full list, as on any other turn.
    expect(r.model.bodies[0].tools.map((t: { name: string }) => t.name)).toEqual(['close_vote', 'offer_replies', 'open_vote', 'react', 'stay_silent', 'update_trip']);
    const { rows } = await db.pool.query('select outcome from turns where turn_id = $1', [`turn_${r.tripId}`]);
    expect(rows[0].outcome).toBe('acted');
  });

  it('a turn under limits never pulls in people\'s new messages: they wait for their own turn, under the normal rules', async () => {
    let asked = false;
    const r = room({
      messages: [msg(3, 'p_arjun', 'what time is check-in?')],
      limits: (wake) => (wake.every((w) => w.kind === 'opening') ? { tools: ['react'], mayPostText: true } : null),
      script: [{ text: 'Check-in is from 2 pm.' }],
      claimNew: async () => {
        asked = true;
        return [];
      },
    });
    await turn(r, [{ id: `opening:${r.tripId}:chat`, tripId: r.tripId, kind: 'opening', ref: 'chat', dueAt: new Date(), payload: {} }]);
    expect(asked).toBe(false);
    expect(r.model.bodies).toHaveLength(1);
    expect(r.posts()[0]?.params.text).toBe('Check-in is from 2 pm.');
  });

  it('a tool outside the limits never reaches the Server, and the text still posts when it may', async () => {
    const ask = msg(3, 'p_priya', '@Go any news?');
    const r = room({
      messages: [ask],
      limits: () => ({ tools: ['react'], mayPostText: true }),
      script: [
        { tools: [{ name: 'open_vote', input: { question: 'When?', options: [{ label: 'Fri' }, { label: 'Sat' }], line: 'When works? Tap your pick.' } }] },
        { text: 'Nothing new yet, I will say when the fares move.' },
      ],
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.calls.map((c) => c.method)).toEqual(['post_message']);
    expect(r.posts()[0]?.params.text).toBe('Nothing new yet, I will say when the fares move.');
  });
});

describe('no ✅ on a line Go asked about', () => {
  const on = (r: ReturnType<typeof room>, method: string, messageId: string) =>
    r.calls.filter((c) => c.method === method && c.params.message_id === messageId);

  it("an unclear expense line gets the question and no ✅: the reflex's quick ✅ is taken back, and a later one never goes", async () => {
    const snacks = msg(3, 'p_priya', 'paid something for the snacks');
    const r = room({ messages: [snacks], script: [{ text: 'How much was it?' }] });
    // The reflex is quicker than a turn: its ✅ is on the line before Go asks.
    expect(await reactOnce(db.pool, r.link, r.tripId, snacks, '✅')).toBe('sent');
    await turn(r, [item(r.tripId, snacks, false)]);
    expect(r.posts()[0]?.params.text).toBe('How much was it?');
    expect(on(r, 'remove_reaction', 'm_3')).toEqual([{ method: 'remove_reaction', params: expect.objectContaining({ trip_id: r.tripId, emoji: '✅' }) }]);
    // The notes pass's own ✅ for the line, later on: nothing is sent.
    expect(await reactOnce(db.pool, r.link, r.tripId, snacks, '✅')).toBe('skipped');
    expect(on(r, 'add_reaction', 'm_3')).toHaveLength(1);
  });

  it('when Go asks before the reflex reacts, the ✅ never goes out and there is nothing to take back', async () => {
    const snacks = msg(3, 'p_priya', 'paid something for the snacks');
    const r = room({ messages: [snacks], script: [{ text: 'How much was it?' }] });
    await turn(r, [item(r.tripId, snacks, false)]);
    expect(await reactOnce(db.pool, r.link, r.tripId, snacks, '✅')).toBe('skipped');
    expect(on(r, 'add_reaction', 'm_3')).toEqual([]);
    expect(on(r, 'remove_reaction', 'm_3')).toEqual([]);
  });

  it('a clear fact still gets its quick ✅', async () => {
    const veg = msg(3, 'p_meher', "I'm veg btw");
    const r = room({ messages: [veg], script: [{ tools: [{ name: 'stay_silent', input: { reason: 'noted already' } }] }] });
    expect(await reactOnce(db.pool, r.link, r.tripId, veg, '✅')).toBe('sent');
    await turn(r, [item(r.tripId, veg, false)]);
    expect(on(r, 'add_reaction', 'm_3')).toHaveLength(1);
    expect(on(r, 'remove_reaction', 'm_3')).toEqual([]);
  });

  it("a question to one of several people keeps the ✅ on the others' lines", async () => {
    const veg = msg(3, 'p_meher', "I'm veg btw");
    const snacks = msg(4, 'p_priya', 'paid something for the snacks');
    const r = room({ messages: [veg, snacks], script: [{ text: 'Priya, how much was it?' }] });
    for (const m of [veg, snacks]) expect(await reactOnce(db.pool, r.link, r.tripId, m, '✅')).toBe('sent');
    await turn(r, [item(r.tripId, veg, false), item(r.tripId, snacks, false)]);
    expect(on(r, 'remove_reaction', 'm_4')).toHaveLength(1);
    expect(on(r, 'remove_reaction', 'm_3')).toEqual([]);
  });

  it('a ✅ the turn puts on a line itself stays, even when it asks something too', async () => {
    const veg = msg(3, 'p_meher', "I'm veg btw, any good thalis near the villa?");
    const r = room({ messages: [veg], script: [{ tools: [{ name: 'react', input: { message_id: '#3', emoji: '✅' } }] }, { text: 'Noted. Want me to look for some?' }] });
    await turn(r, [item(r.tripId, veg, false)]);
    expect(r.posts()[0]?.params.text).toBe('Noted. Want me to look for some?');
    expect(on(r, 'add_reaction', 'm_3')).toHaveLength(1);
    expect(on(r, 'remove_reaction', 'm_3')).toEqual([]);
  });
});

describe('a line that says someone paid but not how much', () => {
  it('gets one short question from Go, and nothing is recorded', async () => {
    const snacks = msg(3, 'p_priya', 'paid something for the snacks');
    // The model follows the hint when its wake line carries it, and stays silent otherwise.
    const hinted = (body: any): boolean => String(body.messages[0].content.at(-2)?.text ?? '').includes(ASK_HOW_MUCH);
    const r = room({
      messages: [snacks],
      script: (body) => (hinted(body) ? { text: 'How much was it, and who was it for?' } : { tools: [{ name: 'stay_silent', input: { reason: 'nothing to add' } }] }),
    });
    await turn(r, [item(r.tripId, snacks, false)]);
    expect(r.model.bodies).toHaveLength(1);
    expect(r.posts().map((p) => p.params.text)).toEqual(['How much was it, and who was it for?']);
    expect(r.calls.filter((c) => c.method === 'add_expense' || c.method === 'add_reaction')).toEqual([]);
  });
});

describe('a reply of card tools ends the turn on its cards', () => {
  // Like travel's tools: a search that returns data, and show_options, a card tool that needs nothing back.
  const search: QuickTool<{ to: string }> = {
    name: 'search_flights', description: 'Searches flights.', input: z.object({ to: z.string() }),
    run: async () => ({ results_id: 'rs_1', found: 3 }),
  };
  const show: QuickTool<{ results_id: string; line?: string | undefined }> = {
    name: 'show_options', description: 'Shows an options card.', input: z.object({ results_id: z.string(), line: z.string().optional() }), endsTurn: true,
    async run(a, ctx) {
      if (a.results_id !== 'rs_1') return { error: 'unknown_results', note: 'Search again.' };
      const cardId = ctx.stableId('c_opt');
      ctx.cards.push({ kind: 'vote', card_id: cardId, fallback_text: 'Friday flights', decision_id: 'd_flights' });
      if (a.line) ctx.lines.push(a.line);
      return { card_id: cardId };
    },
  };
  const searchCall = { name: 'search_flights', input: { to: 'Goa' } };
  const showCall = (results_id = 'rs_1', line?: string) => ({ name: 'show_options', input: { results_id, ...(line ? { line } : {}) } });

  it("search, then the card with its line: two model calls and one post with the line and the card, never the reply's free text", async () => {
    const ask = msg(3, 'p_arjun', '@Go flights Friday evening?');
    // The free text is written before the card is up (run 37586604675, goa-300:73: "I'll show the best three by rating and value.").
    const r = room({
      messages: [ask],
      extraTools: [search, show],
      script: [{ tools: [searchCall] }, { text: "I'll show the best three by rating and value.", tools: [showCall('rs_1', 'Three flights after 6 pm.')] }, { text: 'never asked' }],
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(2);
    expect(r.posts()).toHaveLength(1);
    expect(r.posts()[0]?.params).toMatchObject({ text: 'Three flights after 6 pm.', card: { card_id: `c_opt_turn_${r.tripId}_1` } });
    const { rows } = await db.pool.query('select outcome, rounds from turns where turn_id = $1', [`turn_${r.tripId}`]);
    expect(rows[0]).toMatchObject({ outcome: 'spoke', rounds: 2 });
  });

  it('a card with no line goes up alone, with no model call for a line', async () => {
    const ask = msg(3, 'p_arjun', '@Go show the flights again');
    const r = room({ messages: [ask], extraTools: [show], script: [{ tools: [showCall()] }, { text: 'never asked' }] });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(1);
    expect(r.posts()).toHaveLength(1);
    expect(r.posts()[0]?.params.text).toBeUndefined();
    expect(r.posts()[0]?.params.card).toMatchObject({ kind: 'vote', decision_id: 'd_flights' });
  });

  it('open_vote is a card tool too: the vote and its line in one reply, one model call', async () => {
    const ask = msg(3, 'p_arjun', '@Go villa or resort? put it to a vote');
    const vote = { name: 'open_vote', input: { question: 'Villa or resort?', options: [{ label: 'Villa' }, { label: 'Resort' }], line: 'Vote is up, tap your pick.' } };
    const r = room({ messages: [ask], script: [{ text: "I'll open the vote.", tools: [vote] }, { text: 'never asked' }] });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(1);
    expect(r.posts()[0]?.params).toMatchObject({ text: 'Vote is up, tap your pick.', card: { kind: 'vote', decision_id: 'd_first' } });
  });

  it('a reply with a card tool and a tool that returns data still goes back to the model', async () => {
    const ask = msg(3, 'p_arjun', '@Go flights?');
    // A later reply's own words still win over a card's line from an earlier one.
    const r = room({ messages: [ask], extraTools: [search, show], script: [{ tools: [showCall('rs_1', 'Three flights.'), searchCall] }, { text: 'Here they are.' }] });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(2);
    expect(r.posts()[0]?.params).toMatchObject({ text: 'Here they are.', card: { decision_id: 'd_flights' } });
  });

  it('a card tool that put no card up goes back to the model, like any result', async () => {
    const ask = msg(3, 'p_arjun', '@Go flights?');
    const r = room({ messages: [ask], extraTools: [search, show], script: [{ tools: [showCall('rs_old')] }, { text: 'Let me search again.' }] });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(2);
    expect(r.model.bodies[1].messages.at(-1).content[0].content).toContain('unknown_results');
    expect(r.posts()[0]?.params.text).toBe('Let me search again.');
    expect(r.posts()[0]?.params.card).toBeUndefined();
  });

  it('lines that arrive while the card goes up join the same turn, in the one user turn after the card', async () => {
    const ask = msg(3, 'p_arjun', '@Go flights Friday?');
    const more = msg(5, 'p_kabir', 'also Saturday?');
    let claimed = false;
    const r = room({
      messages: [ask],
      extraTools: [show],
      script: [{ tools: [showCall('rs_1', 'Friday: three flights after 6 pm.')] }, { text: 'Friday has three after 6 pm; Saturday I can check next.' }],
      claimNew: async (tripId) => {
        if (claimed) return [];
        claimed = true;
        r.pack.messages.push(more);
        return [item(tripId, more, false)];
      },
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(2);
    const sent = r.model.bodies[1].messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    // Roles still alternate: the new lines ride in the user turn that holds the card's result.
    for (let k = 1; k < sent.length; k++) expect(sent[k]!.role).not.toBe(sent[k - 1]!.role);
    expect(sent.at(-1)!.content.map((b) => b.type)).toEqual(['tool_result', 'text']);
    expect(sent.at(-1)!.content[1]!.text).toContain('#5 Kabir: also Saturday?');
    expect(r.posts()).toHaveLength(1);
    expect(r.posts()[0]?.params).toMatchObject({ text: 'Friday has three after 6 pm; Saturday I can check next.', card: { decision_id: 'd_flights' } });
  });

  it('a rerun after a crash repeats the same ids: one vote opened, one card posted', async () => {
    const ask = msg(3, 'p_arjun', '@Go put villa or resort to a vote');
    const vote = { name: 'open_vote', input: { question: 'Villa or resort?', options: [{ label: 'Villa' }, { label: 'Resort' }], line: 'Vote is up.' } };
    const r = room({ messages: [ask], script: [{ tools: [vote] }, { tools: [vote] }] });
    // The first post never gets an answer the turn can use: the turn fails after the vote opened.
    const posted = r.speak.post.bind(r.speak);
    let first = true;
    r.speak.post = async (p) => {
      if (first) {
        first = false;
        throw new Error('the post failed');
      }
      return posted(p);
    };
    await expect(turn(r, [item(r.tripId, ask, true)])).rejects.toThrow('the post failed');
    await turn(r, [item(r.tripId, ask, true)], `turn_${r.tripId}`, 2);
    expect(r.calls.filter((c) => c.method === 'open_vote')).toHaveLength(1);
    expect(r.posts()).toHaveLength(1);
    expect(r.posts()[0]?.params.card).toMatchObject({ card_id: `c_vote_turn_${r.tripId}_1`, decision_id: 'd_first' });
  });

  it('under a budget: the card turn spends one hold, and the arrived-meanwhile round the cap refuses keeps the card and its line', async () => {
    const ask = msg(3, 'p_arjun', '@Go flights Friday?');
    const more = msg(5, 'p_kabir', '@Go and Saturday?');
    let claimed = false;
    const budget = createBudget({ pool: db.pool, now: () => new Date(), capUsd: 1, log: silentLog });
    const r = room({
      messages: [ask],
      extraTools: [show],
      budget,
      script: [{ tools: [showCall('rs_1', 'Friday: three flights after 6 pm.')], usage: { input_tokens: 600_000 } }, { text: 'never asked' }],
      claimNew: async (tripId) => {
        if (claimed) return [];
        claimed = true;
        r.pack.messages.push(more);
        return [item(tripId, more, true)];
      },
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(1);
    expect(r.posts().map((p) => [p.params.text, p.params.card?.decision_id])).toEqual([
      ['Friday: three flights after 6 pm.', 'd_flights'],
      [OVER_BUDGET, undefined],
    ]);
  });
});

describe('show the options and put them to a vote in one reply', () => {
  // Travel's own tools on the fake travel backend, as the brain registers them.
  const now = (): Date => new Date('2026-10-07T12:00:00Z');
  const travelOf = () => {
    const results = createResultsStore(db.pool);
    const fake = createFakeTravel({ store: new FakeIxigoStore({ now }), now, payRail: () => 'fake' });
    const travel = createTravelLayer({ switches: { get: () => 'fake' }, now, fake, ixigo: null, results });
    return travelTools({ travel, results, images: createImages({ pool: db.pool, publicUrl: 'https://go.test' }), now });
  };
  const STAYS = { area: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09', guests: 5, must_have: ['pool', 'beach'] };
  const resultsIdOf = (body: any): string => JSON.parse(body.messages.at(-1).content[0].content).results_id;

  it('the card, the vote and the line in one reply: one model call after the search, one vote opened', async () => {
    const ask = msg(3, 'p_priya', '@Go find villas with a pool and put them to a vote');
    const r = room({
      messages: [ask],
      extraTools: travelOf(),
      script: (body, call) =>
        call === 0
          ? { tools: [{ name: 'search_stays', input: STAYS }] }
          : call === 1
            ? {
                // goa-50:24 in run 37586604675 posted this free text with its card.
                text:
                  'Five people at under 8k a head is ₹40,000 a night, so everything fits the cap. "Near the beach" rules out the 15 and 20 minute ones. ' +
                  "I'll show the best-rated villas that are close to the beach.",
                tools: [
                  { name: 'show_options', input: { results_id: resultsIdOf(body), title: 'Villas with a pool', line: 'Three villas with a pool.' } },
                  { name: 'put_to_vote', input: { line: 'Vote is up, tap your pick.' } },
                ],
              }
            : { text: 'never asked' },
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(2);
    expect(r.calls.filter((c) => c.method === 'open_vote')).toHaveLength(1);
    // Both lines ride with the options card, never the free text; the vote card follows it, as every second card does.
    expect(r.posts().map((p) => [p.params.text, p.params.card?.kind])).toEqual([
      ['Three villas with a pool.\nVote is up, tap your pick.', 'options'],
      [undefined, 'vote'],
    ]);
    expect(r.posts()[1]?.params.card).toMatchObject({ decision_id: 'd_first' });
  });

  it('"put the three villas to a vote" on a card shown earlier: the chat line names the card, so one model call opens the vote', async () => {
    // goa-300 line 175 in live run 37578789333: three model calls (recall, trip, search_stays) and 9.88 s, because the
    // chat showed the villas card without its id.
    const find = msg(3, 'p_rahul', 'Go, find us a villa with a pool in North Goa under 8k a head, near the beach');
    const ask = msg(6, 'p_rahul', '@Go put the three villas to a vote please');
    const cardIn = (body: any): string | undefined => /\[options card (c_opt_[\w-]+): /.exec(JSON.stringify(body.messages[0].content))?.[1];
    const r = room({
      messages: [find],
      extraTools: travelOf(),
      script: (body, call) =>
        call === 0
          ? { tools: [{ name: 'search_stays', input: STAYS }] }
          : call === 1
            ? { tools: [{ name: 'show_options', input: { results_id: resultsIdOf(body), title: 'Villas with a pool', line: 'Three villas with a pool.' } }] }
            : call === 2 && cardIn(body)
              ? {
                  // goa-300:175 in run 37586604675 posted this, card id and all.
                  text: "I'll put the most recent villa options card (" + cardIn(body) + ') to a vote.',
                  tools: [{ name: 'put_to_vote', input: { card_id: cardIn(body), line: 'Vote is up, tap your pick.' } }],
                }
              : { text: 'never asked' },
    });
    await turn(r, [item(r.tripId, find, true)]);
    const shown = r.posts()[0]!.params.card;
    expect(shown.kind).toBe('options');
    r.pack.messages.push(msg(5, null, 'Three villas with a pool.', { card: shown }), ask);
    await turn(r, [item(r.tripId, ask, true)], `turn_${r.tripId}_vote`);
    expect(r.model.bodies).toHaveLength(3);
    expect(cardIn(r.model.bodies[2])).toBe(shown.card_id);
    expect(r.calls.filter((c) => c.method === 'open_vote')).toHaveLength(1);
    expect(r.posts().slice(1).map((p) => [p.params.text, p.params.card?.kind])).toEqual([['Vote is up, tap your pick.', 'vote']]);
  });

  it('a vote with no card_id after two options cards is refused, opens nothing, and goes back to the model', async () => {
    const ask = msg(3, 'p_priya', '@Go villas, two sets, and a vote');
    const r = room({
      messages: [ask],
      extraTools: travelOf(),
      script: (body, call) =>
        call === 0
          ? { tools: [{ name: 'search_stays', input: STAYS }] }
          : call === 1
            ? {
                tools: [
                  { name: 'show_options', input: { results_id: resultsIdOf(body), option_numbers: [1, 2], title: 'Two villas', line: 'Two villas.' } },
                  { name: 'show_options', input: { results_id: resultsIdOf(body), option_numbers: [3, 4], title: 'Two more', line: 'Two more.' } },
                  { name: 'put_to_vote', input: { line: 'Vote is up.' } },
                ],
              }
            : { text: 'Which set should we vote on?' },
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(3);
    expect(r.calls.filter((c) => c.method === 'open_vote')).toEqual([]);
    expect(JSON.stringify(r.model.bodies[2].messages.at(-1).content)).toContain('which_card');
    expect(r.posts()[0]?.params.text).toBe('Which set should we vote on?');
  });
});

describe('people Go names', () => {
  it('get a push: the turn posts them as mentions, worked out in code from the trip, not by the model', async () => {
    const ask = msg(3, 'p_arjun', '@Go who pays for the villa?');
    const r = room({ messages: [ask], script: [{ text: 'Priya, you are the payer, so tap Yes, book it. Arjun, nothing for you to do.' }] });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.posts()[0]?.params.mentions).toEqual(['p_priya', 'p_arjun']);
  });
});

describe('an ask that lands while Go writes its hello', () => {
  it('is never lost: when the hello passed over it, it gets a turn of its own and is answered', async () => {
    // Trip t_35e02e110dfa4980: Priya's ask was in Go's copy of the trip when the hello's prompt was built (it shows in
    // "new since"), but its desk item came after, so the hello turn took it at the pre-post check. The hello only said
    // hello, and the ask was never answered.
    const ask = msg(3, 'p_priya', '@Go can you show us 2 or 3 stay options?');
    const woke = (body: any): string => String(body.messages[0].content.at(-2)?.text ?? '');
    let desk: ReturnType<typeof createDesk> | null = null;
    let landed = false;
    const r = room({
      messages: [ask],
      script: (body) => (woke(body).includes('you just joined this trip') ? { text: 'Hi all, I am Go!' } : { text: 'Here are three stays.' }),
      claimNew: async (tripId, turnId) => {
        if (!landed) {
          landed = true;
          await desk!.put({ id: `msg:${tripId}:${ask.message_id}`, tripId, kind: 'message', ref: ask.message_id, dueAt: new Date(), payload: { messageId: ask.message_id, seq: ask.seq, namesGo: true } });
        }
        return desk!.claimNew(tripId, turnId);
      },
      release: (turnId, ids) => desk!.release(turnId, ids),
    });
    desk = createDesk({ pool: db.pool, log: silentLog, now: () => new Date(), holder: 'test', inProcessWake: false });
    desk.setRunner(r.composer.runTurn, r.composer.giveUp);
    await db.pool.query('insert into trips (trip_id) values ($1) on conflict do nothing', [r.tripId]);
    await desk.put({ id: `setup:${r.tripId}:greet`, tripId: r.tripId, kind: 'setup', ref: 'greet', dueAt: new Date(), payload: {} });
    await desk.tick();
    expect(r.posts().map((p) => p.params.text)).toEqual(['Hi all, I am Go!', 'Here are three stays.']);
  });
});

describe("the turn's log line", () => {
  it('says where the time went, round by round, with no words from anyone', () => {
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = { info: (obj: object, msg?: string) => lines.push({ obj: obj as Record<string, unknown>, msg: msg ?? '' }) };
    logTurn(log, {
      tripId: 't_goa', turnId: 'turn_1', wokeFor: ['message'], builtMs: 40, firstToken: new Date(1_000_000 + 1_340), started: 1_000_000, totalMs: 15_200, outcome: 'spoke',
      timings: [
        { tools: ['search_stays'], firstTokenMs: 1_300, modelMs: 2_900, toolMs: 8_400, output: 180, stop: 'tool_use' },
        { tools: ['show_options'], firstTokenMs: 3_100, modelMs: 3_600, toolMs: 300, output: 210, stop: 'tool_use' },
      ],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toBe('turn: 2 rounds, 15.2s: r1 search_stays first 1.3s model 2.9s out 180 tools 8.4s | r2 show_options first 3.1s model 3.6s out 210 tools 0.3s');
    expect(lines[0]!.obj).toMatchObject({
      trip: 't_goa', turn: 'turn_1', woke_for: ['message'], outcome: 'spoke', build_ms: 40, first_token_ms: 1_340, total_ms: 15_200,
      rounds: [
        { tools: ['search_stays'], first_token_ms: 1_300, model_ms: 2_900, tool_ms: 8_400, output_tokens: 180, stop: 'tool_use' },
        { tools: ['show_options'], first_token_ms: 3_100, model_ms: 3_600, tool_ms: 300, output_tokens: 210, stop: 'tool_use' },
      ],
    });
  });
});

describe('an answer with no model call', () => {
  it("a lane's direct answer posts its line (and cards) with no model call, and the turn is written down", async () => {
    const ask = msg(3, 'p_arjun', '@Go villas with a pool in North Goa');
    const r = room({ messages: [ask], script: [{ text: 'never asked' }] });
    const seen: string[] = [];
    r.context.addDirect(async ({ wake, ctx }) => {
      seen.push(wake.map((w) => w.kind).join());
      ctx.lines.push('Pool stays in North Goa for 6 to 9 Nov, from ₹4,334 a night.');
      return true;
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toEqual([]);
    expect(seen).toEqual(['message']);
    expect(r.posts().map((p) => p.params.text)).toEqual(['Pool stays in North Goa for 6 to 9 Nov, from ₹4,334 a night.']);
    const { rows } = await db.pool.query('select outcome, rounds, output_tokens from turns where turn_id = $1', [`turn_${r.tripId}`]);
    expect(rows[0]).toMatchObject({ outcome: 'spoke', rounds: 0, output_tokens: 0 });
  });

  it('a lane that passes leaves the turn to the model, and a turn under limits never asks a lane', async () => {
    const ask = msg(3, 'p_arjun', '@Go villas with a pool in North Goa, which is closest to the beach?');
    const r = room({ messages: [ask], script: [{ text: 'Casa Mareia is the closest, 2 minutes from the sand.' }] });
    r.context.addDirect(async () => false);
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(1);
    expect(r.posts().map((p) => p.params.text)).toEqual(['Casa Mareia is the closest, 2 minutes from the sand.']);
    const limited = room({ messages: [ask], script: [{ tools: [{ name: 'stay_silent', input: { reason: 'proactive' } }] }], limits: () => ({ tools: ['stay_silent'], mayPostText: false }) });
    let asked = 0;
    limited.context.addDirect(async () => {
      asked += 1;
      return true;
    });
    await turn(limited, [item(limited.tripId, ask, true)]);
    expect(asked).toBe(0);
  });
});

describe("a lane's card on the turn's own post (p2's regression red: a new trip opened with two Go posts in a row)", () => {
  const greet = (tripId: string): DeskItem => ({ id: `setup:${tripId}:greet`, tripId, kind: 'setup', ref: 'greet', dueAt: new Date(), payload: {} });
  const HELLO = "Hey all, I'm Go! I can find stays and flights for Goa, run votes and book once you agree.";

  /** The ixigo login lane on the room's own link and pack, as travel/register.ts adds it. */
  function withLogin(r: ReturnType<typeof room>) {
    const login = createIxigoLogin({
      pool: db.pool, link: r.link, packs: { get: async () => r.pack }, runner: () => null, tasks: () => null, screen: () => null, desk: { put: async () => undefined },
      live: () => true, now: () => new Date(), log: { warn: () => undefined, info: () => undefined }, sleep: async () => undefined,
    });
    r.context.addTurnCard((i) => login.helloCard(i));
    return login;
  }

  it("a new trip's first Go post is the hello with the login card and Rahul's line on it, and setup asks nothing after", async () => {
    const r = room({ messages: [], script: [{ text: HELLO }] });
    const login = withLogin(r);
    await turn(r, [greet(r.tripId)]);
    expect(r.posts()).toHaveLength(1);
    const hello = r.posts()[0]!.params;
    expect(hello.text).toBe(`${HELLO}\n${HELLO_LINE.replace('{name}', 'Rahul')}`);
    expect(hello.text).toBe(`${HELLO}\nRahul, first link ixigo once so I can search and book for everyone.`);
    expect(hello.mentions).toEqual(['p_rahul']);
    expect(hello.card).toMatchObject({
      card_id: `c_login_${r.tripId}_0`, kind: 'notice', title: 'Link ixigo for this trip', for_person_ids: ['p_rahul'],
      actions: [{ action_id: 'ixigo_login', only_for_person_ids: ['p_rahul'] }, { action_id: 'ixigo_not_now', only_for_person_ids: ['p_rahul'] }],
    });
    // The hello is in the room now; the setup step that asks after it finds the ask made, and nobody hears from Go twice.
    r.pack.messages.push(msg(101, null, hello.text));
    await login.setupStep.run(r.tripId);
    await login.settled();
    expect(r.posts()).toHaveLength(1);
  });

  it('a trip already logged in to ixigo gets the hello alone, and any other turn never carries the card', async () => {
    const r = room({ messages: [], script: [{ text: HELLO }] });
    withLogin(r);
    await db.pool.query(
      `insert into ixigo_logins (trip_id, person_id, state, attempt, asked_at, logged_in_at, checked_at, updated_at) values ($1, 'p_rahul', 'logged_in', 0, now(), now(), now(), now())`,
      [r.tripId],
    );
    await turn(r, [greet(r.tripId)]);
    expect(r.posts()).toHaveLength(1);
    expect(r.posts()[0]!.params).toMatchObject({ text: HELLO });
    expect(r.posts()[0]!.params.card).toBeUndefined();

    const ask = msg(2, 'p_priya', '@Go hi!');
    const s = room({ messages: [ask], script: [{ text: 'Hi Priya!' }] });
    withLogin(s);
    await turn(s, [item(s.tripId, ask, true)]);
    expect(s.posts()[0]!.params).toMatchObject({ text: 'Hi Priya!' });
    expect(s.posts()[0]!.params.card).toBeUndefined();
  });

  it("a lane's card that fails leaves the post as Go wrote it", async () => {
    const r = room({ messages: [], script: [{ text: HELLO }] });
    r.context.addTurnCard(async () => {
      throw new Error('db down');
    });
    await turn(r, [greet(r.tripId)]);
    expect(r.posts()).toHaveLength(1);
    expect(r.posts()[0]!.params).toMatchObject({ text: HELLO });
    expect(r.posts()[0]!.params.card).toBeUndefined();
  });
});
