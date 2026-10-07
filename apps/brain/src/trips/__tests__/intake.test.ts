import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeLink, type FakeAnswers } from '../../__tests__/fixtures/fake-link.js';
import { ev, goaSnapshot, msg, vote } from '../../__tests__/fixtures/goa.js';
import type { Speak } from '../../composer/speak.js';
import { withSchema } from '../../db/test-db.js';
import { createDesk, type Desk } from '../../desk/desk.js';
import type { TripEvent } from '../../door/methods.js';
import { silentLog } from '../../log.js';
import { UNSURE_READ, type Reflex, type ReflexRead } from '../../reflex/reflex.js';
import { createMessageHooks } from '../hooks.js';
import { createIntake } from '../intake.js';
import { createTripLog } from '../log.js';
import { createPacks } from '../pack.js';
import { createSetup } from '../setup.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

const sure = <T>(value: T) => ({ value, sure: true as const });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(o: { reflex?: (order: string[]) => Reflex; answers?: FakeAnswers; failFirstPut?: boolean; dueNow?: (text: string | null | undefined) => boolean } = {}) {
  const now = () => new Date();
  const order: string[] = [];
  const f = fakeLink({
    read_trip: (p) => goaSnapshot({ trip_id: p.trip_id, seq: 1 }),
    read_messages: () => ({ messages: [], has_more: false }),
    ...o.answers,
  });
  const tripLog = createTripLog({ pool: db.pool, log: silentLog, now });
  const packs = createPacks({ pool: db.pool, link: f.link, log: silentLog, now });
  const setup = createSetup({ pool: db.pool, log: silentLog, now });
  const desk = createDesk({ pool: db.pool, log: silentLog, now, holder: 'intake-test', inProcessWake: false });
  let putFailed = !o.failFirstPut;
  const flakyDesk: Desk = {
    put: async (item) => {
      if (!putFailed && item.kind === 'message') {
        putFailed = true;
        throw new Error('the database blinked');
      }
      await desk.put(item);
    },
    cancel: (tripId, ref) => desk.cancel(tripId, ref),
  };
  const hooks = createMessageHooks(silentLog);
  hooks.onRead(async (m) => {
    order.push(`hook:${m.message_id}`);
    return o.dueNow?.(m.text) ? { dueNow: true } : undefined;
  });
  const emitted: string[] = [];
  tripLog.onEvent((e) => { emitted.push(e.event_id); });
  const speak: Speak = {
    typingOn: (tripId) => { order.push(`typing:${tripId}`); },
    working: () => new Date(),
    typingOff: () => undefined,
    post: async () => [],
    stopAll: () => undefined,
  };
  // The same step registerRoom adds (Task 15).
  setup.addStep({
    name: 'brain.ready',
    run: async (tripId) => {
      const pack = await packs.get(tripId);
      if (!pack.messages.some((m) => m.author.kind === 'go')) {
        await desk.put({ id: `setup:${tripId}:greet`, tripId, kind: 'setup', ref: 'greet', dueAt: now(), payload: {} });
      }
    },
  });
  const reflex: Reflex = o.reflex?.(order) ?? { read: async () => { order.push('reflex'); return UNSURE_READ; } };
  const intake = createIntake({
    pool: db.pool, log: silentLog, now, tripLog, packs, setup, desk: flakyDesk, speak, hooks,
    reflex: () => reflex, runningTasks: async () => [], waitMs: 2_000,
  });
  const send = (e: TripEvent) => intake.sendEvent(e, { instance: 'test', frameId: `gs_${e.event_id}` });
  return { intake, send, f, order, emitted, packs };
}

const open = async (tripId: string) =>
  (await db.pool.query(`select id, kind, ref, due_at, payload, done_at, error from desk_items where trip_id = $1 order by created_at, id`, [tripId])).rows;
const created = (tripId: string) => ev(1, 'trip.created', { trip: goaSnapshot({ trip_id: tripId }) }, tripId);

describe('intake', () => {
  it('answers send_event once the event is written; a repeat is a duplicate and is processed once', async () => {
    const h = harness();
    const e = created('t_in_1');
    expect(await h.send(e)).toEqual({ accepted: true, duplicate: false });
    expect(await h.send(e)).toEqual({ accepted: true, duplicate: true });
    await h.intake.idle();
    expect(h.emitted).toEqual([e.event_id]);
  });

  it('trip.created: the pack comes from the event, setup runs, and Go is due to say hello', async () => {
    const h = harness();
    await h.send(created('t_in_2'));
    await h.intake.idle();
    await vi.waitFor(async () => expect((await open('t_in_2')).map((r) => r.id)).toEqual(['setup:t_in_2:greet']));
    expect(h.f.calls.filter((c) => c.method === 'read_trip')).toHaveLength(0);
  });

  it('"@Go ..." turns typing on at once, before the reflex answers, and waits 2 s on the desk while the thought may go on', async () => {
    const h = harness({ reflex: (order) => ({ read: async () => { await sleep(100); order.push('reflex'); return UNSURE_READ; } }) });
    const T = 't_in_3';
    await h.send(created(T));
    const sentAt = Date.now();
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_arjun', '@Go flights Friday') }, T));
    await h.intake.idle();
    expect(h.order).toEqual([`typing:${T}`, 'reflex', 'hook:m_2']);
    const item = (await open(T)).find((r) => r.kind === 'message');
    expect(item).toMatchObject({ id: `msg:${T}:m_2`, ref: 'm_2', payload: { messageId: 'm_2', seq: 2, namesGo: true } });
    const wait = item.due_at.getTime() - sentAt;
    expect(wait).toBeGreaterThan(1_800);
    expect(wait).toBeLessThan(2_500);
  });

  it('a message to Go that plainly ends a thought is due at once, whatever the reflex says; one not to Go still waits', async () => {
    const h = harness({ reflex: () => ({ read: async () => UNSURE_READ }) });
    const T = 't_in_3b';
    await h.send(created(T));
    const sentAt = Date.now();
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_arjun', '@Go flights Friday?') }, T));
    await h.send(ev(3, 'message.created', { message: msg(3, 'p_priya', 'Go bhai book kar de 😂') }, T));
    await h.send(ev(4, 'message.created', { message: msg(4, 'p_meher', 'what time is check-in?') }, T));
    await h.intake.idle();
    const items = (await open(T)).filter((r) => r.kind === 'message');
    expect(items.map((r) => r.ref)).toEqual(['m_2', 'm_3', 'm_4']);
    expect(items[0]!.due_at.getTime()).toBeLessThanOrEqual(sentAt + 500);
    expect(items[1]!.due_at.getTime()).toBeLessThanOrEqual(sentAt + 500);
    expect(items[2]!.due_at.getTime() - sentAt).toBeGreaterThan(1_500);
  });

  it('the last line of a burst that named Go is due at once when it plainly ends, and the lines before it still wait for it', async () => {
    const h = harness({ reflex: () => ({ read: async () => UNSURE_READ }) });
    const T = 't_in_3d';
    await h.send(created(T));
    const sentAt = Date.now();
    // goa-300's burst, lines 99 to 103, one second apart.
    const burst = ['ok', 'wait', '@Go one thing', 'for my birthday on the 7th', 'is there a good bakery near Anjuna?'];
    for (const [n, text] of burst.entries()) await h.send(ev(n + 2, 'message.created', { message: msg(n + 2, 'p_meher', text) }, T));
    await h.intake.idle();
    const items = (await open(T)).filter((r) => r.kind === 'message');
    expect(items.map((r) => r.ref)).toEqual(['m_2', 'm_3', 'm_4', 'm_5', 'm_6']);
    for (const r of items.slice(0, 4)) expect(r.due_at.getTime() - sentAt, r.ref).toBeGreaterThan(1_500);
    // Due now: the desk's next turn takes it with every message still waiting, so the five lines go as one.
    expect(items[4]!.due_at.getTime()).toBeLessThanOrEqual(sentAt + 500);
  });

  it('a burst whose last line does not plainly end waits as before, and a plain end only counts after the same person named Go', async () => {
    const h = harness({ reflex: () => ({ read: async () => UNSURE_READ }) });
    const T = 't_in_3e';
    await h.send(created(T));
    const sentAt = Date.now();
    // goa-50's burst, lines 29 to 33: nothing in it plainly ends, so all five wait and go as one turn.
    const burst = ['wait', 'one more thing', '@Go can you also check', "if there's a cab from Mopa airport to Anjuna", 'for 5 people with luggage'];
    for (const [n, text] of burst.entries()) await h.send(ev(n + 2, 'message.created', { message: msg(n + 2, 'p_kabir', text) }, T));
    // Someone else's question right after it, and Kabir's own question 7 s after he named Go.
    await h.send(ev(7, 'message.created', { message: msg(7, 'p_priya', 'is there a good bakery near Anjuna?') }, T));
    const later = new Date(Date.parse(msg(4, 'p_kabir', 'x').sent_at) + 7_000).toISOString();
    await h.send(ev(8, 'message.created', { message: msg(8, 'p_kabir', 'is it hot in Goa in November?', { sent_at: later }) }, T));
    await h.intake.idle();
    const items = (await open(T)).filter((r) => r.kind === 'message');
    expect(items.map((r) => r.ref)).toEqual(['m_2', 'm_3', 'm_4', 'm_5', 'm_6', 'm_7', 'm_8']);
    for (const r of items) expect(r.due_at.getTime() - sentAt, r.ref).toBeGreaterThan(1_500);
  });

  it('a message a hook reads as a whole ask is due at once, even one that does not plainly end', async () => {
    const h = harness({ reflex: () => ({ read: async () => UNSURE_READ }), dueNow: (text) => text === '@Go flights Delhi to Goa Friday' });
    const T = 't_in_3c';
    await h.send(created(T));
    const sentAt = Date.now();
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_arjun', '@Go flights Delhi to Goa Friday') }, T));
    await h.send(ev(3, 'message.created', { message: msg(3, 'p_arjun', '@Go one more thing') }, T));
    await h.intake.idle();
    const items = (await open(T)).filter((r) => r.kind === 'message');
    expect(items.map((r) => r.ref)).toEqual(['m_2', 'm_3']);
    expect(items[0]!.due_at.getTime()).toBeLessThanOrEqual(sentAt + 500);
    expect(items[1]!.due_at.getTime() - sentAt).toBeGreaterThan(1_500);
  });

  it('a sure-complete read is due at once; sure chatter gets no item unless it names Go', async () => {
    const read = (m: { text?: string | null }): ReflexRead => {
      if (m.text === 'lol') return { ...UNSURE_READ, forGo: sure(false) };
      if (m.text?.startsWith('@Go')) return { ...UNSURE_READ, forGo: sure(false), complete: sure(true) };
      return { ...UNSURE_READ, complete: sure(true) };
    };
    const h = harness({ reflex: () => ({ read: async (m) => read(m) }) });
    const T = 't_in_4';
    await h.send(created(T));
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_meher', 'lol') }, T));
    await h.send(ev(3, 'message.created', { message: msg(3, 'p_kabir', '@Go is it hot in November?') }, T));
    await h.send(ev(4, 'message.created', { message: msg(4, 'p_priya', 'what time is check-in?') }, T));
    const sentAt = Date.now();
    await h.intake.idle();
    const items = (await open(T)).filter((r) => r.kind === 'message');
    expect(items.map((r) => r.ref)).toEqual(['m_3', 'm_4']);
    for (const r of items) expect(r.due_at.getTime()).toBeLessThanOrEqual(sentAt + 200);
  });

  it('Go\'s own messages and withheld ones never wake Go', async () => {
    const h = harness();
    const T = 't_in_5';
    await h.send(created(T));
    await h.send(ev(2, 'message.created', { message: msg(2, null, 'Hi all!') }, T));
    await h.send(ev(3, 'message.created', { message: msg(3, 'p_meher', 'x', { withheld: true, text: null }) }, T));
    await h.intake.idle();
    expect((await open(T)).filter((r) => r.kind === 'message')).toEqual([]);
    expect(h.order.filter((x) => x.startsWith('hook:'))).toEqual([]);
  });

  it('handles a trip\'s events one at a time in seq order, even when the reflex is slow', async () => {
    const h = harness({
      reflex: () => ({ read: async (m) => { if (m.message_id === 'm_2') await sleep(150); return UNSURE_READ; } }),
    });
    const T = 't_in_6';
    await h.send(created(T));
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_priya', 'first') }, T));
    await h.send(ev(3, 'message.created', { message: msg(3, 'p_rahul', 'second') }, T));
    await h.intake.idle();
    expect(h.order.filter((x) => x.startsWith('hook:'))).toEqual(['hook:m_2', 'hook:m_3']);
  });

  it('a gap (2, then 5): reads the trip and the missed messages page by page, and wakes for what it missed', async () => {
    const T = 't_in_7';
    const h = harness({
      answers: {
        read_trip: (p) => goaSnapshot({ trip_id: p.trip_id, seq: 5 }),
        read_messages: (p) =>
          p.after_seq === 2
            ? { messages: [msg(3, 'p_priya', '@Go are you there?')], has_more: true }
            : { messages: [msg(4, 'p_kabir', 'hello?')], has_more: false },
      },
    });
    await h.send(created(T));
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_rahul', 'hi') }, T));
    await h.intake.idle();
    await h.send(ev(5, 'message.created', { message: msg(5, 'p_arjun', 'anyone?') }, T));
    await h.intake.idle();
    expect(h.f.calls.filter((c) => c.method === 'read_messages').map((c) => c.params.after_seq)).toEqual([2, 3]);
    const items = (await open(T)).filter((r) => r.kind === 'message');
    expect(items.map((r) => r.ref).sort()).toEqual(['m_2', 'm_3', 'm_4', 'm_5']);
    expect(items.find((r) => r.ref === 'm_3')?.payload.namesGo).toBe(true);
  });

  it('the first event for a trip Go already knows: its whole history is read and stored, nothing old wakes Go, and Go does not greet again', async () => {
    const T = 't_in_8';
    const history = [msg(2, null, 'Hi all, I am Go!'), msg(3, 'p_rahul', '@Go find us a villa'), msg(5, null, 'Three villas below.')];
    const h = harness({
      answers: {
        read_trip: (p) => goaSnapshot({ trip_id: p.trip_id, seq: 7 }),
        read_messages: (p) => (p.after_seq === 0 ? { messages: [...history, msg(7, 'p_priya', '@Go hi')], has_more: false } : { messages: [], has_more: false }),
      },
    });
    await h.send(ev(7, 'message.created', { message: msg(7, 'p_priya', '@Go hi') }, T));
    await h.intake.idle();
    await vi.waitFor(async () => {
      const { rows } = await db.pool.query(`select done_at from trip_setup where trip_id = $1 and step = 'brain.ready'`, [T]);
      expect(rows[0]?.done_at).toBeInstanceOf(Date);
    });
    expect(h.f.calls.some((c) => c.method === 'read_trip' && c.params.trip_id === T)).toBe(true);
    expect(h.f.calls.filter((c) => c.method === 'read_messages').map((c) => c.params.after_seq)).toEqual([0]);
    expect((await open(T)).map((r) => r.id)).toEqual([`msg:${T}:m_7`]);
    expect((await h.packs.get(T)).messages.map((m) => m.seq)).toEqual([2, 3, 5, 7]);
    const stored = await db.pool.query<{ n: number }>('select count(*)::int as n from messages where trip_id = $1', [T]);
    expect(stored.rows[0]?.n).toBe(4);
  });

  it('a message whose desk item failed to go in is handled again by the next gap check', async () => {
    const T = 't_in_15';
    const h = harness({
      failFirstPut: true,
      answers: {
        read_messages: (p) => (p.after_seq === 1 ? { messages: [msg(2, 'p_arjun', '@Go hi')], has_more: false } : { messages: [], has_more: false }),
      },
    });
    await h.send(created(T));
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_arjun', '@Go hi') }, T));
    await h.intake.idle();
    expect((await open(T)).filter((r) => r.kind === 'message')).toEqual([]);
    await h.send(ev(3, 'message.created', { message: msg(3, 'p_priya', 'hello?') }, T));
    await h.intake.idle();
    const items = (await open(T)).filter((r) => r.kind === 'message');
    expect(items.map((r) => r.ref).sort()).toEqual(['m_2', 'm_3']);
    expect(items.find((r) => r.ref === 'm_2')?.payload.namesGo).toBe(true);
  });

  it('a deleted message cancels its waiting item', async () => {
    const h = harness();
    const T = 't_in_9';
    await h.send(created(T));
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_priya', 'oops wrong group') }, T));
    await h.send(ev(3, 'message.deleted', { message_id: 'm_2' }, T));
    await h.intake.idle();
    const item = (await open(T)).find((r) => r.ref === 'm_2');
    expect(item?.error).toBe('cancelled');
    expect(item?.done_at).toBeInstanceOf(Date);
  });

  it('a vote closed by people wakes Go; one Go closed does not', async () => {
    const h = harness();
    const T = 't_in_10';
    const closed = (id: string) => vote({ decision_id: id, status: 'closed', voted: 5, tally: [4, 1], result_index: 0, closed_at: '2026-10-05T12:00:00Z' });
    await h.send(created(T));
    await h.send(ev(2, 'decision.closed', { decision: closed('d_stay'), reason: 'everyone_voted' }, T));
    await h.send(ev(3, 'decision.closed', { decision: closed('d_other'), reason: 'closed_by_go' }, T));
    await h.intake.idle();
    const changes = (await open(T)).filter((r) => r.kind === 'trip_change');
    expect(changes.map((r) => r.ref)).toEqual(['decision:d_stay']);
    expect(changes[0]?.payload).toEqual({ type: 'decision.closed', decisionId: 'd_stay', reason: 'everyone_voted' });
  });

  it('recover handles events that were written but never processed before a crash', async () => {
    const T = 't_in_11';
    const before = harness();
    const tripLog = createTripLog({ pool: db.pool, log: silentLog, now: () => new Date() });
    await tripLog.append(created(T));
    await tripLog.append(ev(2, 'message.created', { message: msg(2, 'p_arjun', '@Go hi') }, T));
    expect(await before.intake.recover()).toBeGreaterThanOrEqual(2);
    await before.intake.idle();
    await vi.waitFor(async () => expect((await open(T)).map((r) => r.id).sort()).toEqual([`msg:${T}:m_2`, `setup:${T}:greet`]));
  });

  it('the minute refresh wakes Go for a message it never got as an event', async () => {
    const T = 't_in_12';
    const h = harness({
      answers: {
        read_messages: (p) => (p.trip_id === T ? { messages: [msg(9, 'p_rahul', '@Go still there?')], has_more: false } : { messages: [], has_more: false }),
      },
    });
    await h.send(created(T));
    await h.intake.idle();
    await h.intake.refreshActive();
    await h.intake.idle();
    expect((await open(T)).some((r) => r.ref === 'm_9' && r.payload.namesGo === true)).toBe(true);
  });

  it('one refresh waits per trip, and a refresh that waited reads nothing for a trip marked gone meanwhile', async () => {
    const T = 't_in_gone_1';
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      answers: {
        read_trip: async (p) => {
          await gate;
          return goaSnapshot({ trip_id: p.trip_id, seq: 1 });
        },
      },
    });
    await h.send(created(T));
    await h.intake.idle();
    const reads = (method: string) => h.f.calls.filter((c) => c.method === method && c.params.trip_id === T).length;
    // The first refresh is slow; three more ticks go by meanwhile, and only one of them waits behind it.
    await h.intake.refreshActive();
    await vi.waitFor(() => expect(reads('read_trip')).toBe(1));
    await h.intake.refreshActive();
    await h.intake.refreshActive();
    await h.intake.refreshActive();
    // The Server forgets the trip, and Go marks it gone (the link does this on a 404): its pack goes.
    await db.pool.query('update trips set gone_at = now() where trip_id = $1', [T]);
    h.packs.invalidate(T);
    release();
    await h.intake.idle();
    expect(reads('read_trip')).toBe(1);
    expect(reads('read_messages')).toBe(1);
    // Later ticks don't see it at all.
    await h.intake.refreshActive();
    await h.intake.idle();
    expect(reads('read_trip')).toBe(1);
  });

  it('an event from the Server for a trip marked gone brings it back before anything reads it', async () => {
    const T = 't_in_gone_2';
    const h = harness();
    await h.send(created(T));
    await h.intake.idle();
    await db.pool.query('update trips set gone_at = now() where trip_id = $1', [T]);
    h.packs.invalidate(T);
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_priya', '@Go are we still on?') }, T));
    await h.intake.idle();
    const { rows } = await db.pool.query<{ gone_at: Date | null }>('select gone_at from trips where trip_id = $1', [T]);
    expect(rows[0]?.gone_at).toBeNull();
    expect((await open(T)).some((r) => r.ref === 'm_2')).toBe(true);
  });

  it('"what did I miss" to the group wakes nobody (the App gives each person their own catch-up), but put to Go it does', async () => {
    const h = harness();
    const T = 't_in_missed';
    await h.send(created(T));
    // The real line from goa-300; the reflex was unsure, so it used to wake the composer, which posted a catch-up.
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_rahul', 'meeting khatam, what did I miss') }, T));
    await h.send(ev(3, 'message.created', { message: msg(3, 'p_arjun', '@Go what did I miss?') }, T));
    await h.intake.idle();
    const items = (await open(T)).filter((r) => r.kind === 'message');
    expect(items.map((r) => r.ref)).toEqual(['m_3']);
    expect(items[0]?.payload.namesGo).toBe(true);
  });

  it('hides a card number before anything is written: the trip log, the messages table, the pack, the reflex', async () => {
    const texts: Array<string | null | undefined> = [];
    const h = harness({ reflex: () => ({ read: async (m) => { texts.push(m.text); return UNSURE_READ; } }) });
    const T = 't_in_13';
    const hidden = 'Go bhai Rahul ka card [card number hidden] use kar';
    await h.send(created(T));
    await h.send(
      ev(2, 'message.created', {
        message: msg(2, 'p_kabir', 'Go bhai Rahul ka card 4111 1111 1111 1111 use kar', {
          attachments: [{ kind: 'photo', url: 'https://cdn.go.example/c.jpg', caption: 'card 5555 5555 5555 4444' }],
        }),
      }, T),
    );
    await h.intake.idle();
    const logged = await db.pool.query<{ payload: any }>('select payload from trip_events where trip_id = $1 and seq = 2', [T]);
    expect(logged.rows[0]?.payload.data.message.text).toBe(hidden);
    expect(JSON.stringify(logged.rows[0]?.payload)).not.toMatch(/4111|5555/);
    const stored = await db.pool.query<{ text: string; payload: any }>('select text, payload from messages where trip_id = $1 and message_id = $2', [T, 'm_2']);
    expect(stored.rows[0]?.text).toBe(hidden);
    expect(JSON.stringify(stored.rows[0]?.payload)).not.toMatch(/4111|5555/);
    const inPack = (await h.packs.get(T)).messages.find((m) => m.message_id === 'm_2');
    expect(inPack?.text).toBe(hidden);
    expect(inPack?.attachments[0]).toMatchObject({ caption: 'card [card number hidden]' });
    expect(texts).toEqual([hidden]);
  });

  it('hides a card number in messages read back after a gap too', async () => {
    const T = 't_in_14';
    const h = harness({
      answers: {
        read_trip: (p) => goaSnapshot({ trip_id: p.trip_id, seq: 4 }),
        read_messages: () => ({ messages: [msg(3, 'p_rahul', 'card 4111111111111111 cvv 123')], has_more: false }),
      },
    });
    await h.send(created(T));
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_priya', 'hi') }, T));
    await h.intake.idle();
    await h.send(ev(4, 'message.created', { message: msg(4, 'p_arjun', 'ok') }, T));
    await h.intake.idle();
    const stored = await db.pool.query<{ text: string }>('select text from messages where trip_id = $1 and message_id = $2', [T, 'm_3']);
    expect(stored.rows[0]?.text).toBe('card [card number hidden] cvv [hidden]');
    expect((await h.packs.get(T)).messages.find((m) => m.message_id === 'm_3')?.text).toBe('card [card number hidden] cvv [hidden]');
  });
});
