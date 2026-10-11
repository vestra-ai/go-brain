import * as C from '@go/contract';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import type { EngineAnswer } from '../book/engine.js';
import type { Suggestion } from '../book/lookup.js';
import { TravelError } from '../mcp-travel.js';
import { createGuideOf, createPlaceFor } from '../place-for.js';
import { placeInfo, placeInfoHandler, registerPlaceLearn } from '../place-info.js';

const TOKEN = 'admin-test-token-16';
const LADAKH: Suggestion = { name: 'Ladakh', line: 'India', all: false, country: 'India', placeName: 'Ladakh', place: { locationId: 77, locationType: 'S', lat: 34.15, lng: 77.58 } };
const guide = (best_months: number[]): EngineAnswer => ({
  as: 'facts', title: 'Ladakh', page: 'https://www.ixigo.com/plan/ladakh', checkedAt: '2026-10-11T06:00:00.000Z', ms: 400,
  rows: [{ destination: 'Ladakh, India', photo: 'https://imagedelivery.net/x/ladakh/public', photos: [{ url: 'https://imagedelivery.net/x/pangong/public', label: 'Pangong Lake' }], best_months }],
});
const images = { rehostUrl: async (u: string) => `https://go.test/img/${u.split('/').at(-2)!}.jpg` };
/** Kerala on ixigo: its place box has many entries that fit the word (every town in Kerala), its guide has the state. */
const KERALA: EngineAnswer = {
  as: 'facts', title: 'Kerala', page: 'https://www.ixigo.com/plan/kerala', checkedAt: '2026-10-11T06:00:00.000Z', ms: 400,
  rows: [{ destination: 'Kerala, India', photo: 'https://imagedelivery.net/x/kerala/public', photos: [{ url: 'https://imagedelivery.net/x/alleppey/public', label: 'Alleppey Backwaters' }], best_months: [1, 2, 3, 9, 10, 11, 12] }],
};
const NO_GUIDE: EngineAnswer = { as: 'facts', title: 'x', page: 'https://www.ixigo.com/plan/x', checkedAt: '2026-10-11T06:00:00.000Z', ms: 400, rows: [] };

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
  await db.pool.query("insert into trips (trip_id) values ('t_drill'), ('t_gone')");
  await db.pool.query("update trips set gone_at = now() where trip_id = 't_gone'");
});
afterAll(async () => {
  await db.drop();
});

describe('place_info (rev 5 R6): what a place is like, from the places Go has learned', () => {
  it("answers a learned place with its photos, where it is and its best months, whatever the words' case and spaces", async () => {
    const engine = { suggest: async () => LADAKH, answer: async () => guide([6, 7, 8, 9]) };
    await createPlaceFor({ pool: db.pool, engine: engine as never, images })('Ladakh', { tripId: 't_drill' });
    const info = await placeInfoHandler({ pool: db.pool })({ name: '  ladakh ', from_city: 'Delhi' }, { instance: 'default', frameId: 'f_1' });
    expect(info).toEqual({
      place: {
        name: 'Ladakh', place_id: 'ixigo:77', lat: 34.15, lng: 77.58, timezone: 'Asia/Kolkata', photo_url: 'https://go.test/img/ladakh.jpg',
        photos: [{ url: 'https://go.test/img/pangong.jpg', label: 'Pangong Lake' }],
      },
      best_months: [6, 7, 8, 9],
    });
    expect(C.PlaceInfo.parse(info)).toEqual(info);
  });

  it('answers a place not learned yet, or kept before its months were, as partial: the Server asks again another day', async () => {
    expect(await placeInfo(db.pool, 'Kasol')).toEqual({ place: { name: 'Kasol' }, complete: false });
    await db.pool.query("insert into place_details (words, place, kind) values ('jaipur', $1, 'city')", [{ name: 'Jaipur', place_id: 'ixigo:9' }]);
    expect(await placeInfo(db.pool, 'Jaipur')).toEqual({ place: { name: 'Jaipur', place_id: 'ixigo:9' }, complete: false });
    // A guide that names no months: the whole answer, with none.
    await db.pool.query("update place_details set best_months = '{}' where words = 'jaipur'");
    expect(await placeInfo(db.pool, 'Jaipur')).toEqual({ place: { name: 'Jaipur', place_id: 'ixigo:9' } });
    for (const name of ['Kasol', 'Jaipur']) expect(C.PlaceInfo.safeParse(await placeInfo(db.pool, name)).success).toBe(true);
  });
});

describe('POST /admin/places/learn: a place learned ahead, through a trip of the operator\'s own', () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const appWith = async (o: { token?: string; live?: boolean; engine?: object }) => {
    const app = Fastify();
    const engine = o.engine ?? {
      suggest: async (_id: string, words: string) => (words === 'Gokarna' ? { ...LADAKH, name: 'Gokarna', place: { locationId: 5, locationType: 'C' } } : null),
      answer: async (_id: string, given: Record<string, unknown>) => (given['place'] === 'Gokarna' ? guide([1, 2, 3, 10, 11, 12]) : given['place'] === 'Kerala' ? KERALA : NO_GUIDE),
    };
    registerPlaceLearn(app, {
      adminToken: o.token, pool: db.pool, placeFor: createPlaceFor({ pool: db.pool, engine: engine as never, images }),
      guideOf: createGuideOf({ engine: engine as never, images }), live: () => o.live ?? true,
    });
    await app.ready();
    return app;
  };

  it('learns it through that trip and answers what place_info will', async () => {
    const app = await appWith({ token: TOKEN });
    const res = await app.inject({ method: 'POST', url: '/admin/places/learn', headers: auth, payload: { trip_id: 't_drill', name: 'Gokarna' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ place: { name: 'Gokarna', place_id: 'ixigo:5', photo_url: 'https://go.test/img/ladakh.jpg' }, best_months: [1, 2, 3, 10, 11, 12] });
    expect(res.json()).toEqual(await placeInfo(db.pool, 'gokarna'));
    await app.close();
  });

  it('refuses without the admin token, a bad body, outside ixigo_web, an unknown or gone trip, and a place ixigo does not know', async () => {
    const closed = await appWith({});
    expect((await closed.inject({ method: 'POST', url: '/admin/places/learn', headers: auth, payload: { trip_id: 't_drill', name: 'Goa' } })).statusCode).toBe(404);
    await closed.close();
    const app = await appWith({ token: TOKEN });
    const learn = (payload: object, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url: '/admin/places/learn', headers, payload });
    expect((await learn({ trip_id: 't_drill', name: 'Goa' }, {})).statusCode).toBe(401);
    expect((await learn({ trip_id: 't_drill', name: 'Goa' }, { authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect((await learn({ trip_id: 't_drill' })).statusCode).toBe(422);
    expect((await learn({ trip_id: 't_nowhere', name: 'Goa' })).statusCode).toBe(404);
    expect((await learn({ trip_id: 't_gone', name: 'Goa' })).statusCode).toBe(404);
    const unknown = await learn({ trip_id: 't_drill', name: 'Nowhere at all' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('unknown_place');
    await app.close();
    const fake = await appWith({ token: TOKEN, live: false });
    expect((await fake.inject({ method: 'POST', url: '/admin/places/learn', headers: auth, payload: { trip_id: 't_drill', name: 'Goa' } })).statusCode).toBe(409);
    await fake.close();
  });

  it("learns a place the box can't settle on by ixigo's guide for the words alone: photos and months, no map, never a trip's destination", async () => {
    const asked: string[] = [];
    const engine = {
      suggest: async (_id: string, words: string) => {
        asked.push(`box:${words}`);
        return null;
      },
      answer: async (_id: string, given: Record<string, unknown>) => {
        asked.push(`guide:${String(given['place'])}`);
        return KERALA;
      },
    };
    const app = await appWith({ token: TOKEN, engine });
    const res = await app.inject({ method: 'POST', url: '/admin/places/learn', headers: auth, payload: { trip_id: 't_drill', name: 'Kerala' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      place: { name: 'Kerala', photo_url: 'https://go.test/img/kerala.jpg', photos: [{ url: 'https://go.test/img/alleppey.jpg', label: 'Alleppey Backwaters' }] },
      best_months: [1, 2, 3, 9, 10, 11, 12],
    });
    expect(C.PlaceInfo.parse(res.json())).toEqual(res.json());
    expect(await placeInfo(db.pool, 'kerala')).toEqual(res.json());
    expect(asked).toEqual(['box:Kerala', 'guide:Kerala']);
    // Learned: asked again, nothing loads.
    expect((await app.inject({ method: 'POST', url: '/admin/places/learn', headers: auth, payload: { trip_id: 't_drill', name: 'Kerala' } })).json()).toEqual(res.json());
    expect(asked).toHaveLength(2);
    // A trip whose destination is Kerala still gets no place from it: the guide alone has no id and no map position.
    expect(await createPlaceFor({ pool: db.pool, engine: engine as never, images })('Kerala', { tripId: 't_drill' })).toBeNull();
    // Once the place itself is learned (a trip resolved it), place_info answers that.
    await db.pool.query("insert into place_details (words, place, kind, best_months) values ('kerala', $1, 'state', '{1,2}')", [{ name: 'Kerala', place_id: 'ixigo:9', lat: 10.5, lng: 76.2 }]);
    expect(await placeInfo(db.pool, 'Kerala')).toEqual({ place: { name: 'Kerala', place_id: 'ixigo:9', lat: 10.5, lng: 76.2 }, best_months: [1, 2] });
    await app.close();
  });

  it("says a guide that didn't load as a 502, and keeps nothing", async () => {
    const engine = { suggest: async () => null, answer: async () => { throw new TravelError('refused', 'ixigo asked for a check.'); } };
    const app = await appWith({ token: TOKEN, engine });
    const res = await app.inject({ method: 'POST', url: '/admin/places/learn', headers: auth, payload: { trip_id: 't_drill', name: 'Coorg' } });
    expect(res.statusCode).toBe(502);
    expect(await placeInfo(db.pool, 'Coorg')).toEqual({ place: { name: 'Coorg' }, complete: false });
    await app.close();
  });

  it("says ixigo's refusal as a 502, and keeps nothing", async () => {
    const engine = { suggest: async () => { throw new TravelError('refused', 'ixigo asked for a check.'); }, answer: async () => guide([]) };
    const app = await appWith({ token: TOKEN, engine });
    const res = await app.inject({ method: 'POST', url: '/admin/places/learn', headers: auth, payload: { trip_id: 't_drill', name: 'Varanasi' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toMatch(/ixigo asked for a check/);
    expect(await placeInfo(db.pool, 'Varanasi')).toEqual({ place: { name: 'Varanasi' }, complete: false });
    await app.close();
  });
});
