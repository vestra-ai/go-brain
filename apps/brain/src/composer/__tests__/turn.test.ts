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
import { createFakeTravel } from '../../travel/mcp-travel.js';
import { createResultsStore } from '../../travel/results.js';
import { travelTools } from '../../travel/tools.js';
import { createComposer, OVER_BUDGET, TROUBLE } from '../turn.js';
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
  return { tripId, calls, notes, link, model, composer, pack, speak, released, posts: () => calls.filter((c) => c.method === 'post_message') };
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
            { name: 'open_vote', input: { question: 'Villa or resort?', options: [{ label: 'Villa' }, { label: 'Resort' }] } },
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
    expect(r.model.bodies[0].tools.map((t: { name: string }) => t.name)).toEqual(['close_vote', 'open_vote', 'react', 'stay_silent', 'update_trip']);
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
        { tools: [{ name: 'open_vote', input: { question: 'When?', options: [{ label: 'Fri' }, { label: 'Sat' }] } }] },
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
  const show: QuickTool<{ results_id: string }> = {
    name: 'show_options', description: 'Shows an options card.', input: z.object({ results_id: z.string() }), endsTurn: true,
    async run(a, ctx) {
      if (a.results_id !== 'rs_1') return { error: 'unknown_results', note: 'Search again.' };
      const cardId = ctx.stableId('c_opt');
      ctx.cards.push({ kind: 'vote', card_id: cardId, fallback_text: 'Friday flights', decision_id: 'd_flights' });
      return { card_id: cardId };
    },
  };
  const searchCall = { name: 'search_flights', input: { to: 'Goa' } };
  const showCall = (results_id = 'rs_1') => ({ name: 'show_options', input: { results_id } });

  it('search, then the card with its line: two model calls and one post with the line and the card', async () => {
    const ask = msg(3, 'p_arjun', '@Go flights Friday evening?');
    const r = room({ messages: [ask], extraTools: [search, show], script: [{ tools: [searchCall] }, { text: 'Three flights after 6 pm.', tools: [showCall()] }, { text: 'never asked' }] });
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
    const vote = { name: 'open_vote', input: { question: 'Villa or resort?', options: [{ label: 'Villa' }, { label: 'Resort' }] } };
    const r = room({ messages: [ask], script: [{ text: 'Vote is up, tap your pick.', tools: [vote] }, { text: 'never asked' }] });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(1);
    expect(r.posts()[0]?.params).toMatchObject({ text: 'Vote is up, tap your pick.', card: { kind: 'vote', decision_id: 'd_first' } });
  });

  it('a reply with a card tool and a tool that returns data still goes back to the model', async () => {
    const ask = msg(3, 'p_arjun', '@Go flights?');
    const r = room({ messages: [ask], extraTools: [search, show], script: [{ tools: [showCall(), searchCall] }, { text: 'Here they are.' }] });
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
      script: [{ text: 'Friday: three flights after 6 pm.', tools: [showCall()] }, { text: 'Friday has three after 6 pm; Saturday I can check next.' }],
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
    const vote = { name: 'open_vote', input: { question: 'Villa or resort?', options: [{ label: 'Villa' }, { label: 'Resort' }] } };
    const r = room({ messages: [ask], script: [{ text: 'Vote is up.', tools: [vote] }, { text: 'Vote is up.', tools: [vote] }] });
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
      script: [{ text: 'Friday: three flights after 6 pm.', tools: [showCall()], usage: { input_tokens: 600_000 } }, { text: 'never asked' }],
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
                text: 'Three villas with a pool, vote is up.',
                tools: [{ name: 'show_options', input: { results_id: resultsIdOf(body), title: 'Villas with a pool' } }, { name: 'put_to_vote', input: {} }],
              }
            : { text: 'never asked' },
    });
    await turn(r, [item(r.tripId, ask, true)]);
    expect(r.model.bodies).toHaveLength(2);
    expect(r.calls.filter((c) => c.method === 'open_vote')).toHaveLength(1);
    // The line rides with the options card; the vote card follows it, as every second card does.
    expect(r.posts().map((p) => [p.params.text, p.params.card?.kind])).toEqual([
      ['Three villas with a pool, vote is up.', 'options'],
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
            ? { text: 'Three villas with a pool.', tools: [{ name: 'show_options', input: { results_id: resultsIdOf(body), title: 'Villas with a pool' } }] }
            : call === 2 && cardIn(body)
              ? { text: 'Vote is up, tap your pick.', tools: [{ name: 'put_to_vote', input: { card_id: cardIn(body) } }] }
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
                  { name: 'show_options', input: { results_id: resultsIdOf(body), option_numbers: [1, 2], title: 'Two villas' } },
                  { name: 'show_options', input: { results_id: resultsIdOf(body), option_numbers: [3, 4], title: 'Two more' } },
                  { name: 'put_to_vote', input: {} },
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
