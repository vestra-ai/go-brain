import { Event } from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import type { Trip, TripEvent } from '../../door/methods.js';
import { candidate, fakePacks, goaPack, goaTrip, msg, seedTrip, unsureRead } from '../fakes.js';
import { chatOpening, createOpenings, isHush, tripChangeOpenings, wasEngaged } from '../openings.js';
import { ProactiveStore } from '../store.js';

const NOW = new Date('2026-10-06T06:30:00Z');
const ev = (seq: number, type: string, data: unknown): TripEvent =>
  Event.parse({ event_id: `ev_${seq}`, trip_id: 't_goa', seq, occurred_at: '2026-10-06T06:30:00Z', type, data });
const sureOpening = unsureRead({ opening: { value: true, sure: true } });

describe('isHush', () => {
  const goLine = msg({ id: 'm_go', by: 'go', text: 'Want me to put it to a vote?' });
  const pack = goaPack({ messages: [goLine] });
  it('hears a hush said to Go, in English or Hinglish', () => {
    expect(isHush(msg({ by: 'p_kabir', text: '@Go chup kar yaar', mentionsGo: true }), pack)).toBe(true);
    expect(isHush(msg({ by: 'p_kabir', text: 'too many messages bro', replyTo: 'm_go' }), pack)).toBe(true);
    expect(isHush(msg({ by: 'p_kabir', text: 'Go, please be quiet for a bit', mentionsGo: true }), pack)).toBe(true);
  });
  it('ignores the same words not said to Go', () => {
    expect(isHush(msg({ by: 'p_kabir', text: 'shut up Arjun lol' }), pack)).toBe(false);
    expect(isHush(msg({ by: 'p_kabir', text: 'Go, is the beach quiet in November?', mentionsGo: true }), pack)).toBe(false);
  });
});

describe('chatOpening', () => {
  it('opens a candidate when the reflex is sure, due in 15 s', () => {
    const c = chatOpening(msg({ id: 'm_50', seq: 50, by: 'p_meher', text: 'what time is check-in?' }), sureOpening, NOW, 't_goa');
    expect(c).toMatchObject({ dedupeKey: 'chat:m_50', source: 'opening', topic: 'chat', useful: ['react', 'record', 'message'], facts: { message_id: 'm_50', seq: 50 } });
    expect(c?.dueAt.toISOString()).toBe('2026-10-06T06:30:15.000Z');
  });
  it('does nothing when unsure, when the message is for Go, or for a paused person', () => {
    expect(chatOpening(msg({ text: 'hmm' }), unsureRead(), NOW, 't_goa')).toBeNull();
    expect(chatOpening(msg({ text: '@Go check-in?', mentionsGo: true }), sureOpening, NOW, 't_goa')).toBeNull();
    expect(chatOpening(msg({ text: 'x' }), unsureRead({ opening: { value: true, sure: true }, forGo: { value: true, sure: true } }), NOW, 't_goa')).toBeNull();
    expect(chatOpening(msg({ text: null, withheld: true }), sureOpening, NOW, 't_goa')).toBeNull();
  });
});

describe('tripChangeOpenings', () => {
  const closed = { ...goaTrip().decisions[0]!, status: 'closed' as const, result_index: 0, closed_at: '2026-10-06T06:29:00Z' };
  it('notices a vote a person closed, never one Go closed', () => {
    const [c] = tripChangeOpenings(ev(130, 'decision.closed', { decision: closed, reason: 'closed_by_person' }), goaTrip(), NOW);
    expect(c).toMatchObject({ dedupeKey: 'vote_closed:d_villa', topic: 'vote_closed', useful: ['message'], facts: { winner: 'Villa Sol' } });
    expect(tripChangeOpenings(ev(131, 'decision.closed', { decision: closed, reason: 'closed_by_go' }), goaTrip(), NOW)).toEqual([]);
  });

  it('notices a booking someone else cancelled', () => {
    const booking = { ...goaTrip().bookings[0]!, status: 'cancelled' as const };
    const [c] = tripChangeOpenings(ev(132, 'booking.changed', { booking, change: 'cancelled', by: { kind: 'person', person_id: 'p_kabir' } }), goaTrip(), NOW);
    expect(c).toMatchObject({ dedupeKey: 'booking_cancelled:b_villa', facts: { by: 'p_kabir' } });
    expect(tripChangeOpenings(ev(133, 'booking.changed', { booking, change: 'cancelled', by: { kind: 'go' } }), goaTrip(), NOW)).toEqual([]);
  });

  it('notices new dates that clash with a booking', () => {
    const moved = goaTrip({ dates: { start: '2026-11-13', end: '2026-11-16' } });
    const out = tripChangeOpenings(ev(134, 'trip.updated', { by: { kind: 'person', person_id: 'p_rahul' }, changed: ['dates'] }), moved, NOW);
    expect(out.map((c) => c.dedupeKey)).toEqual(['dates_clash:b_villa:2026-11-13:2026-11-16', 'dates_clash:b_flight:2026-11-13:2026-11-16']);
    expect(tripChangeOpenings(ev(135, 'trip.updated', { by: { kind: 'person', person_id: 'p_rahul' }, changed: ['title'] }), moved, NOW)).toEqual([]);
  });
});

describe('wasEngaged', () => {
  const at = new Date('2026-10-06T06:30:00Z');
  const six = 6 * 3600_000;
  it('counts a reaction, a reply or a word to Go as engagement', () => {
    const goMsg = msg({ id: 'm_go_1', by: 'go', sentAt: '2026-10-06T06:30:05Z' });
    expect(wasEngaged(goaPack({ messages: [goMsg] }), at, six)).toBe(false);
    const reacted = msg({ id: 'm_go_1', by: 'go', sentAt: '2026-10-06T06:30:05Z', reactions: [{ emoji: '👍', person_id: 'p_arjun' }] });
    expect(wasEngaged(goaPack({ messages: [reacted] }), at, six)).toBe(true);
    const reply = msg({ by: 'p_arjun', replyTo: 'm_go_1', sentAt: '2026-10-06T07:00:00Z' });
    expect(wasEngaged(goaPack({ messages: [goMsg, reply] }), at, six)).toBe(true);
  });
  it('treats a nudge that posted nothing as nothing to ignore', () => {
    expect(wasEngaged(goaPack(), at, six)).toBe(true);
  });
});

describe('createOpenings', () => {
  let db: Awaited<ReturnType<typeof withSchema>>;
  let store: ProactiveStore;
  const replanned: string[] = [];
  beforeAll(async () => {
    db = await withSchema();
    store = new ProactiveStore(db.pool);
    await seedTrip(db.pool, 't_goa');
  });
  afterAll(async () => {
    await db.drop();
  });

  const make = (packs = fakePacks(goaPack()), readTrip = async (): Promise<Trip> => goaTrip()) =>
    createOpenings({ store, packs, readTrip, now: () => NOW, replan: async (tripId) => { replanned.push(tripId); } });

  it('stores a chat opening and a hush from what the reflex read', async () => {
    const o = make();
    const pack = goaPack();
    await o.onRead(msg({ id: 'm_60', seq: 60, by: 'p_meher', text: 'anyone know when check-in is?' }), sureOpening, pack);
    await o.onRead(msg({ id: 'm_61', seq: 61, by: 'p_kabir', text: '@Go bas karo', mentionsGo: true }), unsureRead(), pack);
    expect((await store.status('t_goa', 'chat:m_60'))?.status).toBe('pending');
    expect((await store.signals('t_goa', '2026-10-06')).hushCount).toBe(1);
  });

  it('reads the trip again for new dates, adds the clash and re-plans', async () => {
    const moved = goaTrip({ dates: { start: '2026-11-13', end: '2026-11-16' } });
    const o = make(fakePacks(goaPack()), async () => moved);
    await o.onEvent(ev(140, 'trip.updated', { by: { kind: 'person', person_id: 'p_rahul' }, changed: ['dates'] }));
    expect((await store.status('t_goa', 'dates_clash:b_villa:2026-11-13:2026-11-16'))?.status).toBe('pending');
    expect(replanned).toContain('t_goa');
  });

  it('ignores events that change nothing it watches', async () => {
    const before = replanned.length;
    await make().onEvent(ev(141, 'reaction.added', { message_id: 'm_60', reaction: { emoji: '👍', person_id: 'p_priya' } }));
    expect(replanned.length).toBe(before);
  });

  it('counts an unprompted post nobody answered as ignored', async () => {
    const c = candidate({ dedupeKey: 'ign:9' });
    await store.add(c);
    const posted = new Date(NOW.getTime() - 7 * 3600_000);
    await store.promote(c, { allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true, localDay: '2026-10-05' }, posted);
    const pack = goaPack({ messages: [msg({ id: 'm_go_77', by: 'go', sentAt: posted.toISOString() })] });
    expect(await make(fakePacks(pack)).checkIgnored()).toBe(1);
    expect((await store.signals('t_goa', '2026-10-06')).ignoredCount).toBe(1);
    expect(await make(fakePacks(pack)).checkIgnored()).toBe(0);
  });
});
