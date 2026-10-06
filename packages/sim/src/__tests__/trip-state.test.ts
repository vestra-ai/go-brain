import { describe, expect, it } from 'vitest';
import { Event, Message } from '@go/contract';
import { goaFreshTrip } from '../goa.js';
import { SocketCallError } from '../server-socket.js';
import { TripState, mentionsGo } from '../state/trip-state.js';

function setUp(over: { maxPageBytes?: number } = {}) {
  let t = Date.parse('2026-10-05T07:00:00Z');
  let n = 0;
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const s = new TripState(goaFreshTrip(), { mint: (p) => `${p}${String(++n).padStart(4, '0')}`, now: clock.now, ...over });
  s.created();
  return { s, clock };
}

function err(fn: () => unknown): SocketCallError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SocketCallError) return e;
    throw e;
  }
  throw new Error('it did not throw');
}

/** Go's post_message as the FakeServer runs it: once per request_id, params and raw the same here. */
function post(s: TripState, requestId: string, extra: Record<string, unknown>) {
  const p = { request_id: requestId, trip_id: 't_goa', ...extra };
  return s.once(requestId, () => s.postMessage(p as never, p));
}

const notice = { card_id: 'c_n1', kind: 'notice', fallback_text: 'Note', tone: 'info', title: 'Title', body: 'Body' };

describe('change numbers and events', () => {
  it('starts with trip.created as change 1, and every change takes the next number', () => {
    let n = 0;
    const s = new TripState(goaFreshTrip(), { mint: (p) => `${p}${++n}`, now: () => new Date('2026-10-05T07:00:00Z') });
    const created = s.created();
    expect(created).toMatchObject({ type: 'trip.created', seq: 1, trip_id: 't_goa' });
    expect(Event.safeParse(created).success).toBe(true);
    const said = s.say('p_rahul', 'hello all');
    expect(said.events[0]).toMatchObject({ type: 'message.created', seq: 2 });
    expect(s.readTrip().seq).toBe(2);
  });

  it('decides a message is for Go by @Go, a capital Go, or a reply to Go', () => {
    expect(mentionsGo('@Go flights?', false)).toBe(true);
    expect(mentionsGo('@go flights?', false)).toBe(true);
    expect(mentionsGo('Go, find a villa', false)).toBe(true);
    expect(mentionsGo('Go bhai abhi book kar de', false)).toBe(true);
    expect(mentionsGo("let's go to the beach", false)).toBe(false);
    expect(mentionsGo('Goa it is', false)).toBe(false);
    expect(mentionsGo('sounds good', true)).toBe(true);
  });
});

describe('people in the room', () => {
  it('names people, counts a reply to Go as for Go, and withholds a paused person', () => {
    const { s } = setUp();
    const asked = s.say('p_priya', '@Go flights? @Rahul are you in?').result;
    expect(asked).toMatchObject({ mentions_go: true, mentions: ['p_rahul'], withheld: false });
    const goMessage = post(s, 'rq_1', { text: 'Here are three' }).result;
    expect(s.say('p_arjun', 'sounds good', { replyTo: goMessage.message_id }).result.mentions_go).toBe(true);
    s.trip.people.find((p) => p.person_id === 'p_kabir')!.go_paused = true;
    const hidden = s.say('p_kabir', '@Go secret plans').result;
    expect(hidden).toMatchObject({ withheld: true, mentions_go: false, mentions: [], attachments: [] });
    expect(hidden.text).toBeUndefined();
    expect(err(() => s.say('p_stranger', 'hi')).code).toBe(422);
  });

  it('edits and deletes only the author\'s own message', () => {
    const { s } = setUp();
    const m = s.say('p_arjun', 'I land at 9').result;
    const edited = s.edit('p_arjun', m.message_id, 'I land at 11 pm, @Go');
    expect(edited.events[0]).toMatchObject({ type: 'message.edited' });
    expect(edited.result).toMatchObject({ text: 'I land at 11 pm, @Go', mentions_go: true });
    expect(edited.result.edited_at).toBeTruthy();
    expect(err(() => s.edit('p_priya', m.message_id, 'not mine')).code).toBe(409);
    const gone = s.delete('p_arjun', m.message_id);
    expect(gone.events[0]).toMatchObject({ type: 'message.deleted', data: { message_id: m.message_id } });
    const row = s.readMessages({ trip_id: 't_goa', after_seq: 0 }).messages.find((x) => x.message_id === m.message_id)!;
    expect(row.deleted).toBe(true);
    expect(row.text).toBeUndefined();
  });
});

describe('post_message and replace_card', () => {
  it('posts as Go, with the next change number, and its event carries the message', () => {
    const { s } = setUp();
    const asked = s.say('p_priya', '@Go hi').result;
    const done = post(s, 'rq_1', { text: 'Hi Priya', reply_to: asked.message_id, mentions: ['p_priya'] });
    expect(done.repeat).toBe(false);
    expect(done.result).toEqual({ message_id: expect.any(String), seq: 3 });
    const ev = done.events[0]!;
    expect(ev.type).toBe('message.created');
    if (ev.type === 'message.created') {
      expect(ev.data.message).toMatchObject({ author: { kind: 'go' }, mentions_go: false, text: 'Hi Priya', reply_to: asked.message_id, seq: 3 });
    }
  });

  it('does a write once per request_id, and a refused write leaves nothing behind', () => {
    const { s } = setUp();
    const first = post(s, 'rq_1', { text: 'once' });
    const again = post(s, 'rq_1', { text: 'once' });
    expect(again.repeat).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(again.events).toEqual([]);
    expect(s.messages.filter((m) => m.text === 'once')).toHaveLength(1);
    const seqBefore = s.trip.seq;
    expect(err(() => post(s, 'rq_2', { text: 'hi', mentions: ['p_nobody'] }))).toMatchObject({ code: 422, dataCode: 'invalid' });
    expect(s.trip.seq).toBe(seqBefore);
    expect(s.answers.has('rq_2')).toBe(false);
  });

  it('checks reply_to and record card ids, uses each card_id once, and needs a mandate for a mandate card', () => {
    const { s } = setUp();
    expect(err(() => post(s, 'rq_a', { text: 'x', reply_to: 'm_nope' })).code).toBe(422);
    expect(err(() => post(s, 'rq_b', { card: { card_id: 'c_v', kind: 'vote', decision_id: 'd_nope', fallback_text: 'Vote' } })).code).toBe(422);
    post(s, 'rq_c', { card: notice });
    expect(err(() => post(s, 'rq_d', { card: notice })).code).toBe(409);
    s.trip.decisions.push({
      decision_id: 'd_x', question: 'Where?', kind: 'choice', anonymous: false, status: 'closed',
      options: [{ label: 'A' }, { label: 'B' }], voted: 0, of: 5, tally: [0, 0], opened_at: '2026-10-05T07:00:00Z',
    });
    expect(err(() => post(s, 'rq_e', { card: { card_id: 'c_m', kind: 'mandate', decision_id: 'd_x', fallback_text: 'Book?' } })).code).toBe(409);
  });

  it('stores the card exactly as Go sent it, with fields this copy of the contract does not know', () => {
    const { s } = setUp();
    const raw = { request_id: 'rq_raw', trip_id: 't_goa', card: { ...notice, card_id: 'c_new', sparkle: 'a later field' } };
    const parsed = { request_id: 'rq_raw', trip_id: 't_goa', card: { ...notice, card_id: 'c_new' } };
    const done = s.once('rq_raw', () => s.postMessage(parsed as never, raw));
    expect((s.message(done.result.message_id)!.card as Record<string, unknown>).sparkle).toBe('a later field');
    expect((done.events[0] as any).data.message.card.sparkle).toBe('a later field');
  });

  it('replaces a card in place without a change number, and 404s a card that is not there', () => {
    const { s } = setUp();
    post(s, 'rq_1', { card: notice });
    const seq = s.trip.seq;
    const newer = { ...notice, title: 'Updated' };
    expect(s.replaceCard({ trip_id: 't_goa', card: newer } as never, { trip_id: 't_goa', card: newer })).toEqual({ message_id: expect.any(String) });
    expect(s.trip.seq).toBe(seq);
    expect((s.cardMessage('c_n1')!.card as Record<string, unknown>).title).toBe('Updated');
    const missing = { ...notice, card_id: 'c_missing' };
    expect(err(() => s.replaceCard({ trip_id: 't_goa', card: missing } as never, { trip_id: 't_goa', card: missing })).code).toBe(404);
  });
});

describe('typing, reactions and trip details', () => {
  it('shows typing for 10 seconds, or until off, or until Go posts', () => {
    const { s, clock } = setUp();
    s.typing(true);
    expect(s.typingOn()).toBe(true);
    clock.advance(9_000);
    expect(s.typingOn()).toBe(true);
    clock.advance(2_000);
    expect(s.typingOn()).toBe(false);
    s.typing(true);
    s.typing(false);
    expect(s.typingOn()).toBe(false);
    s.typing(true);
    post(s, 'rq_t', { text: 'landed' });
    expect(s.typingOn()).toBe(false);
  });

  it("adds and removes Go's reactions with the contract's rules", () => {
    const { s } = setUp();
    const m = s.say('p_priya', "Let's do North Goa").result;
    const r = (emoji: string, id: string, messageId = m.message_id) => ({ request_id: id, trip_id: 't_goa', message_id: messageId, emoji });
    const added = s.once('rq_r1', () => s.addReaction(r('✅', 'rq_r1')));
    expect(added.events[0]).toMatchObject({ type: 'reaction.added', data: { message_id: m.message_id, reaction: { emoji: '✅', person_id: null } } });
    expect(s.message(m.message_id)!.updated_seq).toBe(added.events[0]!.seq);
    expect(err(() => s.addReaction(r('✅', 'rq_r2'))).code).toBe(409);
    expect(err(() => s.addReaction(r('✅', 'rq_r3', 'm_nope'))).code).toBe(404);
    expect(err(() => s.removeReaction(r('👍', 'rq_r4'))).code).toBe(409);
    expect(s.removeReaction(r('✅', 'rq_r5')).events[0]).toMatchObject({ type: 'reaction.removed', data: { reaction: { emoji: '✅', person_id: null } } });
    s.delete('p_priya', m.message_id);
    expect(err(() => s.addReaction(r('👍', 'rq_r6'))).code).toBe(409);
  });

  it('updates trip details with the contract\'s rules', () => {
    const { s } = setUp();
    expect(err(() => s.updateTrip({ request_id: 'rq_u0', trip_id: 't_goa' })).code).toBe(422);
    expect(err(() => s.updateTrip({ request_id: 'rq_u1', trip_id: 't_goa', dates: { start: '2026-11-09', end: '2026-11-06' } })).code).toBe(422);
    const badItinerary = [{ date: '2026-11-06', items: [{ title: 'Check in', category: 'stay' as const, status: 'booked' as const, booking_id: 'b_nope' }] }];
    expect(err(() => s.updateTrip({ request_id: 'rq_u2', trip_id: 't_goa', itinerary: badItinerary })).code).toBe(422);
    const done = s.updateTrip({ request_id: 'rq_u3', trip_id: 't_goa', title: 'Goa!', dates: { start: '2026-11-06', end: '2026-11-09' } });
    expect(done.events[0]).toMatchObject({ type: 'trip.updated', data: { by: { kind: 'go' }, changed: ['title', 'dates'] } });
    expect(s.readTrip()).toMatchObject({ title: 'Goa!', dates: { start: '2026-11-06', end: '2026-11-09' } });
  });
});

describe('read_messages', () => {
  it('pages in change order, shrinks a page to stay under the frame limit, and loses nothing', () => {
    const { s } = setUp({ maxPageBytes: 3000 });
    const ids = Array.from({ length: 10 }, (_, i) => s.say('p_rahul', `message ${i} ${'x'.repeat(300)}`).result.message_id);
    s.react('p_meher', ids[0]!, '👍'); // a reaction moves message 0 to the end of the change order
    const first = s.readMessages({ trip_id: 't_goa', after_seq: 0, limit: 200 });
    expect(first.has_more).toBe(true);
    expect(first.messages.length).toBeLessThan(10);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(3000);
    const all = [...first.messages];
    let after = first.messages[first.messages.length - 1]!.updated_seq;
    for (let more = first.has_more; more; ) {
      const page = s.readMessages({ trip_id: 't_goa', after_seq: after });
      all.push(...page.messages);
      more = page.has_more;
      after = page.messages[page.messages.length - 1]?.updated_seq ?? after;
    }
    expect(all.map((m) => m.message_id)).toEqual([...ids.slice(1), ids[0]]);
    for (const m of all) expect(Message.safeParse(m).success).toBe(true);
    const limited = s.readMessages({ trip_id: 't_goa', after_seq: 0, limit: 2 });
    expect(limited.messages).toHaveLength(2);
    expect(limited.has_more).toBe(true);
  });
});

describe('needs you', () => {
  it("lists Go cards that name the person and open lines that ask them", () => {
    const { s } = setUp();
    post(s, 'rq_pin', { card: { ...notice, card_id: 'c_pin', fallback_text: 'Rahul, have a look', for_person_ids: ['p_rahul'] } });
    s.trip.record.push({
      line_id: 'r_q', kind: 'open', text: 'Scuba on Saturday?', status: 'active', proof: [], person_ids: ['p_meher'],
      source: 'go', created_at: '2026-10-05T07:00:00Z', updated_at: '2026-10-05T07:00:00Z',
    });
    expect(s.needsYou('p_rahul')).toEqual([{ kind: 'card', ref: 'c_pin', text: 'Rahul, have a look' }]);
    expect(s.needsYou('p_meher')).toEqual([{ kind: 'line', ref: 'r_q', text: 'Scuba on Saturday?' }]);
    expect(s.needsYou('p_kabir')).toEqual([]);
  });
});
