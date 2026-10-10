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
// A line the composer doesn't wake for (pure banter: trips/intake.ts wakesComposer) that the reflex still reads as a moment.
const sureOpening = unsureRead({ opening: { value: true, sure: true }, forGo: { value: false, sure: true }, banter: { value: true, sure: true } });

describe('isHush', () => {
  const goLine = msg({ id: 'm_go', by: 'go', text: 'Want me to put it to a vote?' });
  const pack = goaPack({ messages: [goLine] });
  it('hears a hush said to Go, in English or Hinglish', () => {
    expect(isHush(msg({ by: 'p_kabir', text: '@Go chup kar yaar', mentionsGo: true }), pack)).toBe(true);
    expect(isHush(msg({ by: 'p_kabir', text: 'too many messages bro', replyTo: 'm_go' }), pack)).toBe(true);
    expect(isHush(msg({ by: 'p_kabir', text: 'Go, please be quiet for a bit', mentionsGo: true }), pack)).toBe(true);
  });
  it('hears a hush that names Go in plain text, with no @ mention', () => {
    expect(isHush(msg({ by: 'p_kabir', text: 'Go chup kar yaar' }), pack)).toBe(true);
    expect(isHush(msg({ by: 'p_kabir', text: 'too many messages, Go!' }), pack)).toBe(true);
    expect(isHush(msg({ by: 'p_kabir', text: 'chup kar yaar Arjun' }), pack)).toBe(false);
  });
  it('ignores the same words not said to Go', () => {
    expect(isHush(msg({ by: 'p_kabir', text: 'shut up Arjun lol' }), pack)).toBe(false);
    expect(isHush(msg({ by: 'p_kabir', text: 'Go, is the beach quiet in November?', mentionsGo: true }), pack)).toBe(false);
  });
});

describe('chatOpening', () => {
  it('opens a candidate when the reflex is sure, due in 15 s', () => {
    const c = chatOpening(msg({ id: 'm_50', seq: 50, by: 'p_meher', text: 'what time is check-in?' }), sureOpening, goaPack(), NOW);
    expect(c).toMatchObject({ dedupeKey: 'chat:m_50', source: 'opening', topic: 'chat', useful: ['react', 'record', 'message'], facts: { message_id: 'm_50', seq: 50 } });
    expect(c?.dueAt.toISOString()).toBe('2026-10-06T06:30:15.000Z');
  });
  it('does nothing when unsure, when the message is for Go, or for a paused person', () => {
    expect(chatOpening(msg({ text: 'hmm' }), unsureRead(), goaPack(), NOW)).toBeNull();
    expect(chatOpening(msg({ text: '@Go check-in?', mentionsGo: true }), sureOpening, goaPack(), NOW)).toBeNull();
    expect(chatOpening(msg({ text: 'x' }), unsureRead({ opening: { value: true, sure: true }, forGo: { value: true, sure: true } }), goaPack(), NOW)).toBeNull();
    expect(chatOpening(msg({ text: null, withheld: true }), sureOpening, goaPack(), NOW)).toBeNull();
  });

  // Keshav, 10 Oct: "go can interfere in most of the messages". A line no one spoke to Go in wakes the composer unless it
  // is pure banter, so its moments are the composer's to answer: an opening as well would post twice.
  it("leaves the moments of a line that isn't banter to the composer: a need to keep to, something to settle, a search to run", () => {
    const notForGo = { forGo: { value: false, sure: true } } as const;
    expect(chatOpening(msg({ id: 'm_60', seq: 60, by: 'p_kabir', text: 'guys dates final karo yaar, kal tak' }), unsureRead({ ...notForGo, recordKind: { value: 'open', sure: true } }), goaPack(), NOW)).toBeNull();
    expect(chatOpening(msg({ id: 'm_61', by: 'p_meher', text: "I'm veg btw, so no seafood shacks only" }), unsureRead({ ...notForGo, fact: { value: true, sure: true } }), goaPack(), NOW)).toBeNull();
    expect(chatOpening(msg({ id: 'm_63', by: 'p_arjun', text: 'koi trains dekh lo Mumbai se' }), unsureRead({ ...notForGo, recipe: { value: 'trains', sure: true } }), goaPack(), NOW)).toBeNull();
    // Banter the composer leaves alone opens one only when the reflex is sure of a moment in it.
    const banter = { ...notForGo, banter: { value: true, sure: true } } as const;
    expect(chatOpening(msg({ id: 'm_64', by: 'p_kabir', text: 'haha dates final karo yaar 😂' }), unsureRead({ ...banter, recordKind: { value: 'open', sure: true } }), goaPack(), NOW)).not.toBeNull();
    // Question 11 decides first: sure of something for Go, the composer has the line (no opening); sure of nothing, it doesn't.
    expect(chatOpening(msg({ id: 'm_65', by: 'p_kabir', text: 'haha dates final karo yaar 😂' }), unsureRead({ ...banter, actionable: { value: true, sure: true }, recordKind: { value: 'open', sure: true } }), goaPack(), NOW)).toBeNull();
    expect(chatOpening(msg({ id: 'm_66', by: 'p_kabir', text: 'dates final karo 😂' }), unsureRead({ ...notForGo, actionable: { value: false, sure: true }, recordKind: { value: 'open', sure: true } }), goaPack(), NOW)).not.toBeNull();
    const nothing = unsureRead({ ...banter, fact: { value: false, sure: true }, recordKind: { value: null, sure: true }, recipe: { value: null, sure: true } });
    expect(chatOpening(msg({ by: 'p_kabir', text: 'haha same 😂' }), nothing, goaPack(), NOW)).toBeNull();
  });

  it('leaves a message to the composer unless the reflex is sure it is not for Go and it does not name Go', () => {
    // Unsure whether it is for Go: P1 may answer it, so no opening as well.
    expect(chatOpening(msg({ text: 'what time is check-in?' }), unsureRead({ opening: { value: true, sure: true } }), goaPack(), NOW)).toBeNull();
    // Names Go in plain text, or replies to Go: the composer answers it.
    expect(chatOpening(msg({ text: 'Go, what time is check-in?' }), sureOpening, goaPack(), NOW)).toBeNull();
    const goLine = msg({ id: 'm_go_q', by: 'go', text: 'Want me to check?' });
    expect(chatOpening(msg({ text: 'yes please', replyTo: 'm_go_q' }), sureOpening, goaPack({ messages: [goLine] }), NOW)).toBeNull();
  });
});

describe('tripChangeOpenings', () => {
  const closed = { ...goaTrip().decisions[0]!, status: 'closed' as const, result_index: 0, closed_at: '2026-10-06T06:29:00Z' };
  it('leaves a closed vote to the composer, which P1 already wakes to announce it, so it is never posted twice', () => {
    expect(tripChangeOpenings(ev(130, 'decision.closed', { decision: closed, reason: 'closed_by_person' }), goaTrip(), NOW)).toEqual([]);
    expect(tripChangeOpenings(ev(131, 'decision.closed', { decision: closed, reason: 'everyone_voted' }), goaTrip(), NOW)).toEqual([]);
    expect(tripChangeOpenings(ev(132, 'decision.closed', { decision: closed, reason: 'closed_by_go' }), goaTrip(), NOW)).toEqual([]);
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
