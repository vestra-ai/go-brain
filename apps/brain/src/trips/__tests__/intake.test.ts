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

  it("keeps the Server instance that first brought the trip: the person's browser is keyed by it (tasks/browsers.ts)", async () => {
    const h = harness();
    await h.send(created('t_in_inst'));
    await h.intake.sendEvent(ev(2, 'message.created', { message: msg(2, 'p_arjun', 'see you all there') }, 't_in_inst'), { instance: 'another', frameId: 'gs_other' });
    await h.intake.idle();
    const { rows } = await db.pool.query<{ server_instance: string; server_name: string | null }>('select server_instance, server_name from trips where trip_id = $1', ['t_in_inst']);
    expect(rows[0]).toEqual({ server_instance: 'test', server_name: null });
    // A Server that gives its own name (?server=) has it kept with the instance, from the trip's first event only.
    await h.intake.sendEvent(created('t_in_named'), { instance: 'server-1', server: 'vestra-staging', frameId: 'gs_named' });
    await h.intake.sendEvent(ev(2, 'message.created', { message: msg(2, 'p_arjun', 'hi') }, 't_in_named'), { instance: 'server-2', server: 'another', frameId: 'gs_named_2' });
    await h.intake.idle();
    const named = await db.pool.query('select server_instance, server_name from trips where trip_id = $1', ['t_in_named']);
    expect(named.rows[0]).toEqual({ server_instance: 'server-1', server_name: 'vestra-staging' });
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

  it('a sure-complete read is due at once; pure banter gets no item unless it names Go, and a line no one spoke to Go in does', async () => {
    const read = (m: { text?: string | null }): ReflexRead => {
      if (m.text === 'lol') return { ...UNSURE_READ, forGo: sure(false), banter: sure(true) };
      if (m.text?.startsWith('@Go')) return { ...UNSURE_READ, forGo: sure(false), banter: sure(true), complete: sure(true) };
      // Not spoken to Go, but not banter: Go jumps in wherever it can add anything (Keshav, 10 Oct).
      if (m.text === "I'm veg btw") return { ...UNSURE_READ, forGo: sure(false), complete: sure(true) };
      return { ...UNSURE_READ, complete: sure(true) };
    };
    const h = harness({ reflex: () => ({ read: async (m) => read(m) }) });
    const T = 't_in_4';
    await h.send(created(T));
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_meher', 'lol') }, T));
    await h.send(ev(3, 'message.created', { message: msg(3, 'p_kabir', '@Go is it hot in November?') }, T));
    await h.send(ev(4, 'message.created', { message: msg(4, 'p_priya', 'what time is check-in?') }, T));
    await h.send(ev(5, 'message.created', { message: msg(5, 'p_meher', "I'm veg btw") }, T));
    const sentAt = Date.now();
    await h.intake.idle();
    const items = (await open(T)).filter((r) => r.kind === 'message');
    expect(items.map((r) => r.ref)).toEqual(['m_3', 'm_4', 'm_5']);
    for (const r of items) expect(r.due_at.getTime()).toBeLessThanOrEqual(sentAt + 200);
  });

  // Keshav, 10 Oct: "go only responds to @go? this is not right". A line the quick read is sure asks Go is an ask, its name
  // or not: typing shows, it is due at once when it ends, and the turn takes it as an ask (asksGo).
  it('a line the quick read is sure asks Go is an ask without its name; one it is unsure of stays the group\'s', async () => {
    const read = (m: { text?: string | null }): ReflexRead => (m.text?.startsWith('I want') ? { ...UNSURE_READ, forGo: sure(true) } : UNSURE_READ);
    const h = harness({ reflex: () => ({ read: async (m) => read(m) }) });
    const T = 't_in_asks';
    await h.send(created(T));
    const sentAt = Date.now();
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_meher', 'I want to login again to Ixigo.') }, T));
    await h.send(ev(3, 'message.created', { message: msg(3, 'p_kabir', 'login phir se karna hai shayad') }, T));
    await h.intake.idle();
    expect(h.order).toContain(`typing:${T}`);
    const items = (await open(T)).filter((r) => r.kind === 'message');
    expect(items.map((r) => [r.ref, r.payload])).toEqual([
      ['m_2', { messageId: 'm_2', seq: 2, namesGo: false, asksGo: true }],
      ['m_3', { messageId: 'm_3', seq: 3, namesGo: false }],
    ]);
    // It plainly ends, so it is due at once, as a line naming Go would be.
    expect(items[0]!.due_at.getTime()).toBeLessThanOrEqual(sentAt + 500);
    expect(items[1]!.due_at.getTime() - sentAt).toBeGreaterThan(1_500);
  });

  // Keshav, 10 Oct: "jev decision model should know that many messages even without @go or go can be responded by go".
  it('question 11 sure of something for Go wakes the turn with the jump-in framing; sure of nothing leaves the line, banter or not', async () => {
    const read = (m: { text?: string | null }): ReflexRead => {
      if (m.text === "Arjun can't leave before 6 on Friday") return { ...UNSURE_READ, forGo: sure(false), banter: sure(true), actionable: sure(true) };
      if (m.text === 'arre yaar office mein aaj bahut kaam hai') return { ...UNSURE_READ, forGo: sure(false), actionable: sure(false) };
      return UNSURE_READ;
    };
    const h = harness({ reflex: () => ({ read: async (m) => read(m) }) });
    const T = 't_in_actionable';
    await h.send(created(T));
    await h.send(ev(2, 'message.created', { message: msg(2, 'p_meher', "Arjun can't leave before 6 on Friday") }, T));
    await h.send(ev(3, 'message.created', { message: msg(3, 'p_kabir', 'arre yaar office mein aaj bahut kaam hai') }, T));
    await h.intake.idle();
    const items = (await open(T)).filter((r) => r.kind === 'message');
    expect(items.map((r) => [r.ref, r.payload])).toEqual([['m_2', { messageId: 'm_2', seq: 2, namesGo: false, actionable: true }]]);
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

  // Contract 1.1 tolerance (1): a message from the Server itself (author system: "Priya added a photo", a check-in
  // reminder) is kept, as an event or read back after a gap, and Go never answers it as if a person spoke, even "@Go".
  it('a message from the Server itself is kept and never wakes Go, as an event or read back after a gap', async () => {
    const T = 't_in_system';
    const system = (seq: number, text: string) => msg(seq, null, text, { author: { kind: 'system' }, mentions_go: true });
    const h = harness({
      answers: {
        read_trip: (p) => goaSnapshot({ trip_id: p.trip_id, seq: 5 }),
        read_messages: () => ({ messages: [system(3, '@Go Kabir shared a location'), msg(4, 'p_kabir', 'there it is')], has_more: false }),
      },
    });
    await h.send(created(T));
    await h.send(ev(2, 'message.created', { message: system(2, '@Go Priya added 3 photos') }, T));
    await h.send(ev(5, 'message.created', { message: msg(5, 'p_arjun', 'nice') }, T));
    await h.intake.idle();
    const items = (await open(T)).filter((r) => r.kind === 'message');
    expect(items.map((r) => r.ref).sort()).toEqual(['m_4', 'm_5']);
    expect(h.order.filter((x) => x.startsWith('typing:') || x === 'hook:m_2' || x === 'hook:m_3')).toEqual([]);
    const pack = await h.packs.get(T);
    expect(pack.messages.filter((m) => m.author.kind === 'system').map((m) => m.message_id)).toEqual(['m_2', 'm_3']);
  });

  // The Server team, 10 Oct (GO-TEAM-ASKS-REV4 A4): a line for every money movement, the expenses Go adds too, with no
  // event of its own, so Go reads them back at the next gap. They are the trip's record: no turn, no chime-in (the reflex
  // and the lanes' hooks, where chime-ins start, never see them), no typing. On 8 Oct Go commented on one.
  it("the App's money lines, read back with no event of their own, wake no turn and no chime-in", async () => {
    const T = 't_in_money_lines';
    const lines = [
      'Priya added Airport cab · ₹1,700 · split 4 ways',
      'Go added Villa Sol · ₹54,200 · paid by Rahul · split 4 ways',
      'Priya changed the split of Airport cab · ₹1,700 · 3 ways',
      'Priya removed Airport cab · ₹1,700',
      'Aarav paid Rahul ₹5,800',
    ];
    const system = (seq: number, text: string) => msg(seq, null, text, { author: { kind: 'system' } });
    const h = harness({
      reflex: (order) => ({ read: async (m) => { order.push(`reflex:${m.message_id}`); return UNSURE_READ; } }),
      answers: {
        read_trip: (p) => goaSnapshot({ trip_id: p.trip_id, seq: 6 }),
        read_messages: () => ({ messages: lines.map((t, i) => system(i + 2, t)), has_more: false }),
      },
    });
    await h.send(created(T));
    await h.send(ev(7, 'message.created', { message: msg(7, 'p_arjun', 'ok') }, T));
    await h.intake.idle();
    expect((await open(T)).filter((r) => r.kind === 'message').map((r) => r.ref)).toEqual(['m_7']);
    expect(h.order).toEqual(['reflex:m_7', 'hook:m_7']);
    const pack = await h.packs.get(T);
    expect(pack.messages.filter((m) => m.author.kind === 'system').map((m) => m.text)).toEqual(lines);
  });

  // Contract 1.1 tolerance (2): replace_card changes no change number by the contract, but a Server that bumps a
  // message's updated_seq when Go replaces its card hands it back from read_messages. It wakes nobody, and a person's
  // message read back again (a reaction moved its updated_seq) is not handled twice.
  it('a message read back after a gap with only its card replaced, or a reaction, wakes nobody and is not handled twice', async () => {
    const T = 't_in_replaced';
    const card = (state: 'running' | 'done') => ({
      kind: 'working' as const, card_id: 'c_live_1', fallback_text: 'Go is searching hotels on ixigo.', task_id: 'search_1',
      title: 'Searching hotels on ixigo', state, steps: [{ text: 'Opening ixigo hotels', state: state === 'done' ? 'done' as const : 'doing' as const }],
      updated_at: '2026-10-08T10:00:00Z',
    });
    const h = harness({
      answers: {
        read_trip: (p) => goaSnapshot({ trip_id: p.trip_id, seq: 6 }),
        read_messages: () => ({
          messages: [
            msg(2, null, 'On it.', { card: card('done'), updated_seq: 4 }),
            msg(3, 'p_priya', '@Go stays in Palolem?', { updated_seq: 5, reactions: [{ emoji: '👍', person_id: 'p_rahul' }] }),
          ],
          has_more: false,
        }),
      },
    });
    await h.send(created(T));
    await h.send(ev(2, 'message.created', { message: msg(2, null, 'On it.', { card: card('running') }) }, T));
    await h.send(ev(3, 'message.created', { message: msg(3, 'p_priya', '@Go stays in Palolem?') }, T));
    await h.intake.idle();
    const before = (await open(T)).filter((r) => r.kind === 'message');
    expect(before.map((r) => r.ref)).toEqual(['m_3']);
    const hooksBefore = h.order.filter((x) => x.startsWith('hook:')).length;
    await h.send(ev(6, 'message.created', { message: msg(6, 'p_meher', 'ok') }, T));
    await h.intake.idle();
    const after = (await open(T)).filter((r) => r.kind === 'message');
    expect(after.map((r) => r.ref)).toEqual(['m_3', 'm_6']);
    expect(h.order.filter((x) => x.startsWith('hook:')).slice(hooksBefore)).toEqual(['hook:m_6']);
    const pack = await h.packs.get(T);
    expect(pack.messages.find((m) => m.message_id === 'm_2')?.card).toMatchObject({ state: 'done' });
  });

  // Contract 1.1 tolerance (3): expense.changed's new answers (approved, disputed) and a payback (settlement.recorded)
  // are taken: the trip is read again for the Server's money, and nothing breaks.
  it("takes 1.1's expense answers and paybacks: each reads the trip again, and Go carries on", async () => {
    const T = 't_in_money11';
    const h = harness({ answers: { read_trip: (p) => goaSnapshot({ trip_id: p.trip_id, seq: 4 }) } });
    await h.send(created(T));
    const expense = {
      expense_id: 'x_1', paid_by_person_id: 'p_rahul', amount_minor: 240000, currency: 'INR', note: 'Cab to Anjuna', category: 'getting_around' as const,
      split_person_ids: ['p_rahul', 'p_priya'], created_at: '2026-10-08T10:00:00Z', status: 'approved' as const,
      confirmations: [{ person_id: 'p_priya', state: 'approved' as const, at: '2026-10-08T10:05:00Z' }],
    };
    const reads = () => h.f.calls.filter((c) => c.method === 'read_trip').length;
    const first = reads();
    await h.send(ev(2, 'expense.changed', { expense, change: 'approved', by: { kind: 'person', person_id: 'p_priya' }, by_person_id: 'p_priya' }, T));
    await h.send(ev(3, 'expense.changed', { expense: { ...expense, status: 'disputed' }, change: 'disputed', by: { kind: 'person', person_id: 'p_priya' }, by_person_id: 'p_priya' }, T));
    await h.send(ev(4, 'settlement.recorded', {
      settlement: {
        settlement_id: 'st_1', from_person_id: 'p_priya', to_person_id: 'p_rahul', amount_minor: 120000, currency: 'INR', method: 'upi',
        status: 'confirmed', recorded_at: '2026-10-08T10:58:00Z', confirmed_at: '2026-10-08T11:00:00Z',
      },
      by: { kind: 'person', person_id: 'p_rahul' },
    }, T));
    await h.intake.idle();
    expect(reads()).toBeGreaterThan(first);
    await h.send(ev(5, 'message.created', { message: msg(5, 'p_arjun', '@Go who owes what now?') }, T));
    await h.intake.idle();
    expect((await open(T)).filter((r) => r.kind === 'message').map((r) => r.ref)).toEqual(['m_5']);
  });

  // GO-TEAM-ASKS-REV4 B2 and A1 (the Server team, 10 Oct): a fixed split comes as change "updated" with the whole expense
  // (no answers on it any more), and a payback counts once recorded. Each reads the trip again, like any money change.
  it('takes a fixed split (updated) and a payback that counts once recorded: each reads the trip again', async () => {
    const T = 't_in_money_rev4';
    const h = harness({ answers: { read_trip: (p) => goaSnapshot({ trip_id: p.trip_id, seq: 3 }) } });
    await h.send(created(T));
    await h.intake.idle();
    const expense = {
      expense_id: 'x_2', paid_by_person_id: 'p_priya', amount_minor: 170000, currency: 'INR', note: 'Airport cab', category: 'getting_around' as const,
      split_person_ids: ['p_priya', 'p_rahul', 'p_arjun'], created_at: '2026-10-10T08:00:00Z',
    };
    const reads = () => h.f.calls.filter((c) => c.method === 'read_trip').length;
    const first = reads();
    expect(await h.send(ev(2, 'expense.changed', { expense, change: 'updated', by: { kind: 'person', person_id: 'p_priya' } }, T))).toEqual({ accepted: true, duplicate: false });
    await h.intake.idle();
    const afterSplit = reads();
    expect(afterSplit).toBeGreaterThan(first);
    const at = '2026-10-10T09:02:00Z';
    await h.send(ev(3, 'settlement.recorded', {
      settlement: { settlement_id: 'st_2', from_person_id: 'p_arjun', to_person_id: 'p_priya', amount_minor: 56700, currency: 'INR', method: 'cash', status: 'confirmed', recorded_at: at, confirmed_at: at },
      by: { kind: 'person', person_id: 'p_arjun' },
    }, T));
    await h.intake.idle();
    expect(reads()).toBeGreaterThan(afterSplit);
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
