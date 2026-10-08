import { Event } from '@go/contract';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { TripGoneError } from '../../trips/gone.js';
import { registerFireRoute } from '../../watches/admin.js';
import { candidate, fakeBrain, goaPack, goaTrip, manualTime, seedTrip, turnCtx } from '../fakes.js';
import { proactiveOf } from '../payload.js';
import { startProactive } from '../register.js';
import { ProactiveStore } from '../store.js';

const TOKEN = 'admin-test-token';
const fire = {
  trip_id: 't_goa',
  label: 'IndiGo 6E 2134',
  person_ids: ['p_arjun'],
  delay_minutes: 120,
  arrive_at: '2026-11-06T22:45:00+05:30',
  note: "Arjun's airport cab is booked for 9 pm",
};

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
  await seedTrip(db.pool, 't_goa');
});
afterAll(async () => {
  await db.drop();
});

describe('startProactive', () => {
  it('registers its hooks, the turn rules, wake renderers, the openings block and the notice tools', async () => {
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now, env: { ADMIN_TOKEN: TOKEN } });
    const h = await startProactive(brain, { intervals: false, travel: null });
    expect(reg.tools.map((t) => t.name)).toEqual(['post_notice', 'update_notice']);
    expect([...reg.wakes.keys()]).toEqual(['timer', 'watch', 'opening']);
    expect(reg.nows.map((n) => n.name)).toEqual(['openings']);
    expect(reg.turnRules).toHaveLength(1);
    expect(reg.stops).toHaveLength(1); // its timers stop when Go stops
    expect(reg.onRead).toHaveLength(1);
    expect(reg.onEvent).toHaveLength(1);
    h.stop();
  });

  it('refuses to start, loudly, when P1 cannot limit a proactive turn', async () => {
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now });
    delete (brain.context as { addTurnRules?: unknown }).addTurnRules;
    await expect(startProactive(brain, { intervals: false, travel: null })).rejects.toThrow(/addTurnRules/);
    expect(reg.tools).toEqual([]);
    expect(reg.onRead).toEqual([]);
  });

  it('plays the 3:40 demo beat: a simulated delay pinned to Arjun, labelled, within one pass', async () => {
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain, app, reg, desk, link } = fakeBrain({ pool: db.pool, now: time.now, env: { ADMIN_TOKEN: TOKEN } });
    await startProactive(brain, { intervals: false, travel: null });

    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', payload: fire })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: { authorization: 'Bearer nope' }, payload: fire })).statusCode).toBe(401);
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { trip_id: 't_goa' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...fire, trip_id: 't_nowhere' } })).statusCode).toBe(404);

    const res = await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: fire });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, promoted: 1 });

    // A fire that names people is only ever a pin for them, never a message to everyone.
    const useful = await db.pool.query<{ useful: string[] }>(`select useful from proactive_candidates where trip_id = 't_goa' and dedupe_key = $1`, [res.json().dedupe_key]);
    expect(useful.rows[0]?.useful).toEqual(['pin']);
    const item = desk.items.at(-1)!;
    expect(item.kind).toBe('watch');
    expect(proactiveOf(item)).toMatchObject({ allowed: ['pin'], forPersonIds: ['p_arjun'], candidate: { simulated: true } });
    // What P1's turn gets for this item: a pin through post_notice, reading, stay_silent, and no text message.
    expect(reg.turnRules[0]!([item])).toEqual({ tools: expect.arrayContaining(['post_notice', 'stay_silent']), mayPostText: false });
    expect(reg.turnRules[0]!([item])?.tools).not.toContain('call_business');
    const wakeText = reg.wakes.get('watch')!(item, goaPack());
    expect(wakeText).toContain('Simulated for the demo');
    expect(wakeText).toContain('running 120 minutes late');

    const post = reg.tools.find((t) => t.name === 'post_notice')!;
    const ctx = turnCtx({ link, pack: goaPack(), wake: [item] });
    await post.run(post.input.parse({ tone: 'heads_up', title: 'Your flight is 2 hours late', body: 'You now land at 10:45 pm, but your cab is at 9. Want me to move it to 11?' }), ctx);
    const card = ctx.cards[0] as Record<string, unknown>;
    expect(card).toMatchObject({ kind: 'notice', for_person_ids: ['p_arjun'], source: { name: 'Simulated for the demo' } });

    // A double click sends the same fire again: it posts once.
    const again = (await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: fire })).json();
    expect(again).toMatchObject({ ok: true, duplicate: true, promoted: 0, dedupe_key: res.json().dedupe_key });
    // Another nudge three minutes later, with nobody speaking since, is "two in a row": it waits. A rehearsal resets the budget first.
    time.advance(3 * 60_000);
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...fire, delay_minutes: 150 } })).json()).toMatchObject({ promoted: 0 });
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...fire, delay_minutes: 180, reset_budget: true } })).json()).toMatchObject({ promoted: 1 });
  });

  it('the stage fire (force: true) reaches the desk once and pins one labelled notice to Arjun, with the budget spent and a hush on; without force it is held', async () => {
    await seedTrip(db.pool, 't_stage');
    const time = manualTime('2026-10-06T06:30:00Z');
    const pack = goaPack({ trip: goaTrip({ trip_id: 't_stage' }) });
    const { brain, app, reg, desk, link } = fakeBrain({ pool: db.pool, now: time.now, env: { ADMIN_TOKEN: TOKEN }, pack });
    const h = await startProactive(brain, { intervals: false, travel: null });
    // The real trip's day so far: three unprompted posts (nobody has spoken since), a hush and an ignored nudge.
    for (let i = 0; i < 3; i += 1) {
      const c = candidate({ tripId: 't_stage', dedupeKey: `spent:${i}` });
      await h.store.add(c);
      await h.store.promote(c, { allowed: ['pin'], forPersonIds: ['p_arjun'], counted: true, localDay: '2026-10-06' }, new Date(time.now().getTime() - (i + 1) * 600_000));
    }
    await h.store.hush('t_stage', time.now());
    await h.store.ignored('t_stage', time.now());
    const auth = { authorization: `Bearer ${TOKEN}` };
    const stage = { ...fire, trip_id: 't_stage' };

    const held = (await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: stage })).json();
    expect(held).toMatchObject({ ok: true, promoted: 0 });
    // The day's budget is spent and the fire expires in 2 hours, before tomorrow's budget: held back for good.
    expect(await h.store.status('t_stage', held.dedupe_key)).toMatchObject({ status: 'dropped', reason: 'budget' });
    expect(desk.items).toHaveLength(0);

    const forced = (await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...stage, force: true } })).json();
    expect(forced).toMatchObject({ ok: true, promoted: 1 });
    expect(forced.dedupe_key).not.toBe(held.dedupe_key);
    // The operator's double click.
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...stage, force: true } })).json()).toMatchObject({ duplicate: true, promoted: 0 });
    expect(desk.items).toHaveLength(1);

    const item = desk.items[0]!;
    expect(proactiveOf(item)).toMatchObject({ allowed: ['pin'], forPersonIds: ['p_arjun'], candidate: { simulated: true, forced: true } });
    const post = reg.tools.find((t) => t.name === 'post_notice')!;
    const ctx = turnCtx({ link, pack, wake: [item] });
    await post.run(post.input.parse({ tone: 'heads_up', title: 'Your flight is 2 hours late', body: 'You now land at 10:45 pm, but your cab is at 9. Want me to move it to 11?' }), ctx);
    expect(ctx.cards).toHaveLength(1);
    expect(ctx.cards[0]).toMatchObject({ kind: 'notice', for_person_ids: ['p_arjun'], source: { name: 'Simulated for the demo' } });
    expect(await h.store.status('t_stage', forced.dedupe_key)).toMatchObject({ status: 'promoted', counted: true });
  });

  // p5's robustness drill, 8 Oct: a forced fire at a trip the Server forgot answered 500 "The Server no longer has trip …".
  it('a fire at a trip the Server no longer has is a typed 404, before anything is added, and when the trip goes mid-pass', async () => {
    await seedTrip(db.pool, 't_fire_gone');
    await db.pool.query(`update trips set gone_at = now() where trip_id = 't_fire_gone'`);
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain, app, desk } = fakeBrain({ pool: db.pool, now: time.now, env: { ADMIN_TOKEN: TOKEN } });
    await startProactive(brain, { intervals: false, travel: null });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const gone = await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...fire, trip_id: 't_fire_gone', force: true } });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({ error: { code: 'not_found', message: 'that trip is gone' } });
    expect((await db.pool.query(`select 1 from proactive_candidates where trip_id = 't_fire_gone'`)).rowCount).toBe(0);
    expect(desk.items).toHaveLength(0);
    // A trip Go never had is still "no such trip".
    expect((await app.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...fire, trip_id: 't_nowhere' } })).json())
      .toEqual({ error: { code: 'not_found', message: 'no such trip' } });

    // The Server forgets the trip while the pass runs: the pass's TripGoneError is the same 404, never a 500.
    await seedTrip(db.pool, 't_fire_race');
    const race = Fastify();
    registerFireRoute(race, { adminToken: TOKEN, store: new ProactiveStore(db.pool), now: time.now, promote: async (tripId) => { throw new TripGoneError(tripId); } });
    const mid = await race.inject({ method: 'POST', url: '/admin/watch/fire', headers: auth, payload: { ...fire, trip_id: 't_fire_race', force: true } });
    expect(mid.statusCode).toBe(404);
    expect(mid.json()).toEqual({ error: { code: 'not_found', message: 'that trip is gone' } });
    await race.close();
  });

  it('plans timers and watches when a trip is created, and the sweep re-plans them', async () => {
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain, reg } = fakeBrain({ pool: db.pool, now: time.now });
    const h = await startProactive(brain, { intervals: false, travel: null });
    const created = Event.parse({ event_id: 'ev_1', trip_id: 't_goa', seq: 1, occurred_at: '2026-10-06T06:30:00Z', type: 'trip.created', data: { trip: goaPack().trip } });
    await reg.onEvent[0]!(created);
    const timers = await db.pool.query(`select dedupe_key from proactive_candidates where trip_id = 't_goa' and source = 'timer' and status = 'pending'`);
    expect(timers.rows.map((r: { dedupe_key: string }) => r.dedupe_key)).toContain('travel_day:2026-11-06');
    const watches = await db.pool.query(`select watch_id from watches where trip_id = 't_goa' and active`);
    expect(watches.rows.length).toBeGreaterThan(0);
    await expect(h.sweep()).resolves.toBeUndefined();
  });

  it('the sweep never reads or re-plans a trip the Server no longer has', async () => {
    const time = manualTime('2026-10-06T06:30:00Z');
    const { brain } = fakeBrain({ pool: db.pool, now: time.now });
    const h = await startProactive(brain, { intervals: false, travel: null });
    await seedTrip(db.pool, 't_swept_gone');
    await db.pool.query(`update trips set gone_at = $2, created_at = $2 where trip_id = $1`, ['t_swept_gone', time.now()]);
    await h.sweep();
    const link = brain.door.link as unknown as { of(method: string): Array<Record<string, unknown>> };
    expect(link.of('read_trip').map((p) => p.trip_id)).not.toContain('t_swept_gone');
    const timers = await db.pool.query(`select 1 from proactive_candidates where trip_id = 't_swept_gone'`);
    expect(timers.rowCount).toBe(0);
  });
});
