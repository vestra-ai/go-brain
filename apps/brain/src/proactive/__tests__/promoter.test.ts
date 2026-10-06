import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { candidate, fakeDesk, fakePacks, goaPack, goaTrip, manualTime, msg, seedTrip, waitFor } from '../fakes.js';
import { proactiveOf } from '../payload.js';
import { createPromoter, moodFrom } from '../promoter.js';
import { ProactiveStore } from '../store.js';

const NOON = '2026-10-06T06:30:00Z';
const LATE = '2026-10-06T17:00:00Z';
const log = { warn: (): void => {} };

let db: Awaited<ReturnType<typeof withSchema>>;
let store: ProactiveStore;
beforeAll(async () => {
  db = await withSchema();
  store = new ProactiveStore(db.pool);
  for (const t of ['t_goa', 't_full', 't_late']) await seedTrip(db.pool, t);
});
afterAll(async () => {
  await db.drop();
});

const packs = fakePacks(
  goaPack(),
  goaPack({ trip: goaTrip({ trip_id: 't_full' }) }),
  goaPack({ trip: goaTrip({ trip_id: 't_late' }) }),
);

describe('moodFrom', () => {
  it('reads paused people and the last person message from the pack', () => {
    const base = goaTrip();
    const trip = goaTrip({ people: base.people.map((p) => (p.person_id === 'p_meher' ? { ...p, go_paused: true } : p)) });
    const pack = goaPack({
      trip,
      messages: [
        msg({ by: 'p_priya', sentAt: '2026-10-06T06:00:00Z' }),
        msg({ by: 'go', sentAt: '2026-10-06T06:05:00Z' }),
      ],
    });
    const m = moodFrom({ postsToday: 1, lastProactivePostAt: null, hushCount: 0, lastHushAt: null, ignoredCount: 0 }, pack, 'Asia/Kolkata');
    expect(m.pausedPersonIds).toEqual(['p_meher']);
    expect(m.lastPersonMessageAt?.toISOString()).toBe('2026-10-06T06:00:00.000Z');
    expect(m.lastGoMessageAt?.toISOString()).toBe('2026-10-06T06:05:00.000Z');
    expect(m.postsToday).toBe(1);
  });
});

describe('createPromoter', () => {
  it('puts a passing candidate on the desk once, with what the bar allowed', async () => {
    const time = manualTime(NOON);
    const desk = fakeDesk();
    const p = createPromoter({ store, desk, packs, now: time.now, log });
    await store.add(candidate({ dedupeKey: 'delay:1', dueAt: new Date(Date.parse(NOON) - 1000) }));
    await store.add(candidate({ dedupeKey: 'later:1', dueAt: new Date(Date.parse(NOON) + 60_000) }));

    expect(await p.tick()).toBe(1);
    expect(await p.tick()).toBe(0);
    expect(desk.items).toHaveLength(1);
    const item = desk.items[0]!;
    expect(item).toMatchObject({ id: 'watch:t_goa:delay:1', tripId: 't_goa', kind: 'watch', ref: 'watch:t_goa:delay:1' });
    expect(item.dueAt.toISOString()).toBe('2026-10-06T06:30:00.000Z');
    expect(proactiveOf(item)).toMatchObject({ allowed: ['pin'], forPersonIds: ['p_arjun'], tz: 'Asia/Kolkata' });
    expect(await store.status('t_goa', 'delay:1')).toMatchObject({ status: 'promoted', counted: true, allowed: ['pin'] });
    expect((await store.status('t_goa', 'later:1'))?.status).toBe('pending');
  });

  it('drops a candidate that is no longer true', async () => {
    const desk = fakeDesk();
    const p = createPromoter({ store, desk, packs, now: manualTime(NOON).now, log });
    await store.add(candidate({ dedupeKey: 'vote:stale', source: 'timer', topic: 'vote_closing', useful: ['pin'], facts: { decision_id: 'd_villa', closes_at: '2026-10-01T00:00:00Z' }, dueAt: new Date(Date.parse(NOON) - 1000) }));
    await p.tick();
    expect(desk.items).toHaveLength(0);
    expect(await store.status('t_goa', 'vote:stale')).toMatchObject({ status: 'dropped', reason: 'no_longer_true' });
  });

  it('waits for tomorrow morning once the day budget is spent', async () => {
    const desk = fakeDesk();
    const now = new Date(NOON);
    for (let i = 0; i < 3; i += 1) {
      const c = candidate({ tripId: 't_full', dedupeKey: `spent:${i}` });
      await store.add(c);
      await store.promote(c, { allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true, localDay: '2026-10-06' }, new Date(now.getTime() - (i + 1) * 3600_000));
    }
    const pack = goaPack({ trip: goaTrip({ trip_id: 't_full' }), messages: [msg({ by: 'p_priya', sentAt: '2026-10-06T06:20:00Z' })] });
    const p = createPromoter({ store, desk, packs: fakePacks(pack), now: () => now, log });
    await store.add(candidate({ tripId: 't_full', dedupeKey: 'over:1', useful: ['pin'], dueAt: new Date(now.getTime() - 1000) }));
    await p.tick();
    expect(desk.items).toHaveLength(0);
    const s = await store.status('t_full', 'over:1');
    expect(s).toMatchObject({ status: 'pending', reason: 'budget' });
    expect(s?.dueAt.toISOString()).toBe('2026-10-07T02:30:00.000Z');
  });

  it('holds a message until 8 am at night in the trip time zone', async () => {
    const desk = fakeDesk();
    const p = createPromoter({ store, desk, packs, now: manualTime(LATE).now, log });
    await store.add(candidate({ tripId: 't_late', dedupeKey: 'closed:1', source: 'opening', topic: 'vote_closed', importance: 0.8, urgency: 0.8, useful: ['message'], personIds: [], dueAt: new Date(Date.parse(LATE) - 1000) }));
    await p.tick();
    expect(desk.items).toHaveLength(0);
    const s = await store.status('t_late', 'closed:1');
    expect(s).toMatchObject({ status: 'pending', reason: 'night' });
    expect(s?.dueAt.toISOString()).toBe('2026-10-07T02:30:00.000Z');
  });

  it('joins a pass already running instead of running two', async () => {
    const desk = fakeDesk();
    const p = createPromoter({ store, desk, packs, now: manualTime(NOON).now, log });
    await store.add(candidate({ dedupeKey: 'join:1', personIds: [], useful: ['react'], dueAt: new Date(Date.parse(NOON) - 1000) }));
    const [a, b] = await Promise.all([p.tick(), p.tick()]);
    expect(a).toBe(b);
    expect(desk.items.filter((i) => i.id === 'watch:t_goa:join:1')).toHaveLength(1);
  });

  it('promotes one trip at once for the stage fire, queued behind a pass already running, and includes what came due meanwhile', async () => {
    await seedTrip(db.pool, 't_fire');
    packs.set(goaPack({ trip: goaTrip({ trip_id: 't_fire' }) }));
    const inner = fakeDesk();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const desk = { ...inner, put: async (item: Parameters<typeof inner.put>[0]): Promise<void> => { held = true; await gate; await inner.put(item); } };
    const p = createPromoter({ store, desk, packs, now: manualTime(NOON).now, log });
    const quiet = { tripId: 't_fire', topic: 'note', personIds: [], useful: ['update_card' as const], dueAt: new Date(Date.parse(NOON) - 1000) };
    await store.add(candidate({ ...quiet, dedupeKey: 'fire:a' }));
    const pass = p.tick();
    await waitFor(() => held); // the pass has read what was due and is held at the desk
    await store.add(candidate({ ...quiet, dedupeKey: 'fire:b' })); // the stage fire, while the pass runs
    const fire = p.promoteTrip('t_fire');
    release();
    expect(await pass).toBeGreaterThanOrEqual(1);
    expect(await fire).toBe(1);
    expect((await store.status('t_fire', 'fire:b'))?.status).toBe('promoted');
    expect(inner.items.filter((i) => i.tripId === 't_fire').map((i) => i.id).sort()).toEqual(['watch:t_fire:fire:a', 'watch:t_fire:fire:b']);
    expect(await p.promoteTrip('t_fire')).toBe(0);
  });

  it('keeps a trip due when its pack cannot be read', async () => {
    const warned: object[] = [];
    const desk = fakeDesk();
    await seedTrip(db.pool, 't_ghost');
    const p = createPromoter({ store, desk, packs: fakePacks(), now: manualTime(NOON).now, log: { warn: (o: object) => { warned.push(o); } } });
    await store.add(candidate({ tripId: 't_ghost', dedupeKey: 'ghost:1', dueAt: new Date(Date.parse(NOON) - 1000) }));
    await p.tick();
    expect(warned.length).toBeGreaterThan(0);
    expect((await store.status('t_ghost', 'ghost:1'))?.status).toBe('pending');
  });
});
