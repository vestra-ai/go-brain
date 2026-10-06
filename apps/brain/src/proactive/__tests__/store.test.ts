import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { candidate, seedTrip } from '../fakes.js';
import { ProactiveStore } from '../store.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let store: ProactiveStore;
const NOON = new Date('2026-10-06T06:30:00Z');

beforeAll(async () => {
  db = await withSchema();
  store = new ProactiveStore(db.pool);
  await seedTrip(db.pool, 't_goa', 'Asia/Kolkata');
});
afterAll(async () => {
  await db.drop();
});

describe('ProactiveStore', () => {
  it('never adds the same nudge twice, even after it was dropped', async () => {
    const c = candidate({ dedupeKey: 'once:1' });
    expect(await store.add(c)).toBe('added');
    expect(await store.add(c)).toBe('exists');
    await store.drop(c, 'below_bar', NOON);
    expect(await store.add(c)).toBe('exists');
    expect((await store.status('t_goa', 'once:1'))?.status).toBe('dropped');
  });

  it('returns only pending candidates that are due', async () => {
    const due = candidate({ dedupeKey: 'due:1', dueAt: new Date(NOON.getTime() - 1000) });
    const later = candidate({ dedupeKey: 'due:2', dueAt: new Date(NOON.getTime() + 60_000) });
    await store.add(due);
    await store.add(later);
    const keys = (await store.due(NOON)).map((c) => c.dedupeKey);
    expect(keys).toContain('due:1');
    expect(keys).not.toContain('due:2');
    const got = (await store.due(NOON)).find((c) => c.dedupeKey === 'due:1');
    expect(got).toMatchObject({ tripId: 't_goa', source: 'watch', useful: ['pin', 'message'], personIds: ['p_arjun'], importance: 0.9 });
    expect(got).not.toHaveProperty('forced');
  });

  it('keeps the stage fire marked forced', async () => {
    await store.add(candidate({ dedupeKey: 'sim:forced:1', simulated: true, forced: true, dueAt: new Date(NOON.getTime() - 1000) }));
    expect((await store.due(NOON)).find((c) => c.dedupeKey === 'sim:forced:1')).toMatchObject({ simulated: true, forced: true });
    await store.drop(candidate({ dedupeKey: 'sim:forced:1' }), 'test_done', NOON);
  });

  it('moves a pending timer, leaves a decided one alone, and revives one dropped by re-planning', async () => {
    const t = candidate({ dedupeKey: 'timer:1', source: 'timer', topic: 'travel_day', dueAt: NOON });
    await store.plan(t);
    await store.plan({ ...t, dueAt: new Date(NOON.getTime() + 3600_000) });
    expect((await store.status('t_goa', 'timer:1'))?.dueAt.toISOString()).toBe('2026-10-06T07:30:00.000Z');

    expect(await store.dropUnplanned('t_goa', [], NOON)).toBeGreaterThanOrEqual(1);
    expect((await store.status('t_goa', 'timer:1'))?.reason).toBe('replanned');
    await store.plan(t);
    expect((await store.status('t_goa', 'timer:1'))?.status).toBe('pending');

    await store.promote(t, { allowed: ['message'], forPersonIds: [], counted: true, localDay: '2026-10-06' }, NOON);
    await store.plan({ ...t, dueAt: new Date(NOON.getTime() + 7200_000) });
    expect((await store.status('t_goa', 'timer:1'))?.status).toBe('promoted');
  });

  it('defers a candidate to a later time with a reason', async () => {
    const c = candidate({ dedupeKey: 'defer:1', dueAt: NOON });
    await store.add(c);
    await store.defer(c, new Date('2026-10-07T02:30:00Z'), 'night');
    const s = await store.status('t_goa', 'defer:1');
    expect(s).toMatchObject({ status: 'pending', reason: 'night' });
    expect(s?.dueAt.toISOString()).toBe('2026-10-07T02:30:00.000Z');
  });

  it('counts posts per local day by batch, and a reset clears them', async () => {
    await seedTrip(db.pool, 't_budget', 'Asia/Kolkata');
    const a = candidate({ tripId: 't_budget', dedupeKey: 'b:1' });
    const b = candidate({ tripId: 't_budget', dedupeKey: 'b:2' });
    const c = candidate({ tripId: 't_budget', dedupeKey: 'b:3' });
    for (const x of [a, b, c]) await store.add(x);
    const day = '2026-10-06';
    await store.promote(a, { allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true, localDay: day }, NOON);
    await store.promote(b, { allowed: ['message'], forPersonIds: [], counted: true, localDay: day }, NOON); // same batch
    const later = new Date(NOON.getTime() + 3600_000);
    await store.promote(c, { allowed: ['react'], forPersonIds: [], counted: false, localDay: day }, later);
    const sig = await store.signals('t_budget', day);
    expect(sig.postsToday).toBe(1);
    expect(sig.lastProactivePostAt?.toISOString()).toBe(NOON.toISOString());
    expect(await store.resetBudget('t_budget', day)).toBe(2);
    expect((await store.signals('t_budget', day)).postsToday).toBe(0);
  });

  it('keeps hushes and ignored nudges per trip', async () => {
    await store.hush('t_goa', NOON);
    await store.hush('t_goa', NOON);
    await store.ignored('t_goa', NOON);
    const sig = await store.signals('t_goa', '2026-10-06');
    expect(sig).toMatchObject({ hushCount: 2, ignoredCount: 1 });
    expect(sig.lastHushAt?.toISOString()).toBe(NOON.toISOString());
  });

  it('reads the trip time zone, with India as the fallback', async () => {
    await seedTrip(db.pool, 't_london', 'Europe/London');
    expect(await store.tripTz('t_london')).toBe('Europe/London');
    expect(await store.tripTz('t_nowhere')).toBe('Asia/Kolkata');
    expect(await store.tripExists('t_goa')).toBe(true);
    expect(await store.tripExists('t_nowhere')).toBe(false);
  });

  it('lists the unprompted posts that still need the ignored check', async () => {
    const c = candidate({ dedupeKey: 'ign:1' });
    await store.add(c);
    await store.promote(c, { allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true, localDay: '2026-10-06' }, NOON);
    const rows = await store.toCheckForIgnored(new Date(NOON.getTime() + 1000));
    expect(rows).toContainEqual({ tripId: 't_goa', dedupeKey: 'ign:1', decidedAt: NOON });
    await store.ignoreChecked('t_goa', 'ign:1', NOON);
    expect((await store.toCheckForIgnored(new Date(NOON.getTime() + 1000))).map((r) => r.dedupeKey)).not.toContain('ign:1');
  });

  it('saves and reads back a notice card', async () => {
    const card = { card_id: 'c_notice_1', kind: 'notice' as const, fallback_text: 'Heads up', tone: 'heads_up' as const, title: 'Heads up', body: 'Your flight is late.' };
    await store.saveNotice({ tripId: 't_goa', cardId: 'c_notice_1', messageId: null, card });
    expect(await store.notice('t_goa', 'c_notice_1')).toEqual({ tripId: 't_goa', cardId: 'c_notice_1', messageId: null, card });
    expect(await store.notice('t_goa', 'c_missing')).toBeNull();
  });
});
