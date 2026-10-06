import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeAnthropic, type Script } from '../../__tests__/fixtures/fake-anthropic.js';
import { goaSnapshot, msg } from '../../__tests__/fixtures/goa.js';
import { withSchema } from '../../db/test-db.js';
import type { DeskItem } from '../../desk/desk.js';
import type { Message } from '../../door/methods.js';
import { createServerLink } from '../../door/server-link.js';
import { silentLog } from '../../log.js';
import type { TripPack } from '../../trips/pack.js';
import { createContext, type TurnLimits } from '../context.js';
import { roomTools } from '../room-tools.js';
import { createSpeak } from '../speak.js';
import { createTools } from '../tools.js';
import { createComposer, TROUBLE } from '../turn.js';
import { renderMessageWake, renderSetupWake, renderTripChangeWake } from '../wakes.js';

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
  limits?: (wake: DeskItem[]) => TurnLimits | null;
}) {
  const tripId = `t_turn_${++rooms}`;
  const calls: Array<{ method: string; params: any }> = [];
  const notes: Array<{ method: string; params: any }> = [];
  const link = createServerLink({ pool: db.pool, log: silentLog, timeoutMs: 1_000 });
  const answers: Record<string, () => Record<string, unknown>> = {
    post_message: () => ({ message_id: `m_go_${calls.length}`, seq: 100 + calls.length }),
    add_reaction: () => ({ seq: 100 + calls.length }),
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
  for (const t of roomTools({ now: () => new Date() })) tools.register(t);
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
  });
  return { tripId, calls, notes, model, composer, pack, speak, posts: () => calls.filter((c) => c.method === 'post_message') };
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
