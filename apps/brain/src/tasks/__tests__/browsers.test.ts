import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import type { TripPack } from '../../trips/pack.js';
import { browserUserIdFor, createBrowsers, type Browsers } from '../browsers.js';
import { v1UserIdFor } from '../computer.js';
import { FakeV1 } from '../testing/fake-v1.js';
import { FakeClock, TEST_START_MS } from '../testing/lane-brain.js';
import { createV1Client } from '../v1-client.js';

// Keshav, 9 Oct: "I dont want to login again and again, fix this". One browser per Server instance and trip organizer:
// every trip of theirs reads ixigo.com in it, so one login serves them all.
const KEYS = [`vk_test_${'a'.repeat(43)}`, `vk_test_${'b'.repeat(43)}`];
const ADMIN = `vk_test_${'z'.repeat(43)}`;
let db: Awaited<ReturnType<typeof withSchema>>;
let fake: FakeV1;
let clock: FakeClock;
let browsers: Browsers;
const log = { warn: vi.fn() };
/** Each trip's organizer, as its pack says it; a test changes one to see the trip's browser stay. */
const organizers = new Map<string, string>();

/** A trip the Server brought on an instance, organized by someone; server is the Server's own name, when it gives one. */
async function trip(tripId: string, instance: string | null, organizer: string, server: string | null = null): Promise<void> {
  organizers.set(tripId, organizer);
  await db.pool.query(
    'insert into trips (trip_id, server_instance, server_name) values ($1, $2, $3) on conflict (trip_id) do nothing',
    [tripId, instance, server],
  );
}

beforeAll(async () => {
  db = await withSchema();
  clock = new FakeClock(TEST_START_MS);
  fake = new FakeV1({ keys: KEYS, adminKey: ADMIN, now: clock.now });
  await fake.start();
  const v1 = createV1Client({ baseUrl: fake.url, keys: KEYS, adminKey: ADMIN, sleep: async () => undefined });
  const packs = { get: async (tripId: string) => ({ trip: { organizer_person_id: organizers.get(tripId) ?? 'p_nobody' } }) as unknown as TripPack };
  browsers = createBrowsers({ pool: db.pool, v1, packs, env: { VESTRA_DEPLOYMENT_ID: 'dep_go' }, now: clock.now, log });
});
afterAll(async () => {
  await fake.close();
  await db.drop();
});

describe("the person's browser", () => {
  it("is one per Server instance and organizer: two trips of Rahul's on one Server share it, made once on /v1 with the admin key", async () => {
    await trip('t_b_1', 'try-room-keshav', 'p_rahul');
    await trip('t_b_2', 'try-room-keshav', 'p_rahul');
    const one = await browsers.userFor('t_b_1');
    expect(one).toBe(browserUserIdFor('try-room-keshav', 'p_rahul'));
    expect(one).toMatch(/^gobrowser-[0-9a-f]{32}$/);
    // Never the trip's own job computer.
    expect(one).not.toBe(v1UserIdFor('t_b_1'));
    expect(await browsers.userFor('t_b_2')).toBe(one);
    const posts = fake.callsTo('POST', /^\/v1\/users$/).filter((c) => (c.body as { user_id?: string }).user_id === one);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers.authorization).toBe(`Bearer ${ADMIN}`);
    expect(fake.users.get(one)?.default_deployment).toBe('dep_go');
    // Another Server's Rahul, or another organizer on this one, is another person: another browser.
    await trip('t_b_3', 'app-server', 'p_rahul');
    await trip('t_b_4', 'try-room-keshav', 'p_priya');
    expect(await browsers.userFor('t_b_3')).toBe(browserUserIdFor('app-server', 'p_rahul'));
    expect(await browsers.userFor('t_b_4')).toBe(browserUserIdFor('try-room-keshav', 'p_priya'));
  });

  it('is fixed for a trip the first time it uses one: an organizer who changes later never moves it', async () => {
    await trip('t_b_fixed', 'try-room-keshav', 'p_meher');
    const first = await browsers.userFor('t_b_fixed');
    organizers.set('t_b_fixed', 'p_kabir');
    expect(await browsers.userFor('t_b_fixed')).toBe(first);
    // A trip whose Server instance Go has not heard yet takes the door's own name for a socket that gives none.
    await trip('t_b_noinst', null, 'p_rahul');
    expect(await browsers.userFor('t_b_noinst')).toBe(browserUserIdFor('default', 'p_rahul'));
  });

  it("says in the log when one organizer comes under two Server instances within a day: their Server must use one name", async () => {
    log.warn.mockClear();
    await trip('t_b_name_1', 'server-replica-a', 'p_twice');
    await browsers.userFor('t_b_name_1');
    expect(log.warn).not.toHaveBeenCalled();
    await trip('t_b_name_2', 'server-replica-b', 'p_twice');
    await browsers.userFor('t_b_name_2');
    expect(log.warn).toHaveBeenCalledWith(
      { personId: 'p_twice', name: 'server-replica-b', others: ['server-replica-a'] },
      expect.stringContaining('one organizer under two Server names within a day'),
    );
    // A day on, the old name is history: nothing said.
    log.warn.mockClear();
    clock.advance(25 * 3600_000);
    await trip('t_b_name_3', 'server-replica-c', 'p_twice');
    await browsers.userFor('t_b_name_3');
    expect(log.warn).not.toHaveBeenCalled();
    // Two replicas of a Server that gives its name are one name: nothing said.
    await trip('t_b_name_4', 'server-replica-a', 'p_once', 'one-server');
    await trip('t_b_name_5', 'server-replica-b', 'p_once', 'one-server');
    await browsers.userFor('t_b_name_4');
    await browsers.userFor('t_b_name_5');
    expect(log.warn).not.toHaveBeenCalled();
  });

  // A Server with replicas names each one apart (?instance=, so their signatures differ) and gives one name for all of
  // them (?server=): the person's browser, and their ixigo login, is the same whichever replica brought the trip.
  it("is one per Server and organizer when the Server gives its name: trips from two of its replicas share it", async () => {
    await trip('t_b_srv_1', 'vestra-1', 'p_rahul', 'vestra-staging');
    await trip('t_b_srv_2', 'vestra-2', 'p_rahul', 'vestra-staging');
    const one = await browsers.userFor('t_b_srv_1');
    expect(one).toBe(browserUserIdFor('vestra-staging', 'p_rahul'));
    expect(await browsers.userFor('t_b_srv_2')).toBe(one);
    // Another Server's Rahul is another person, even on a replica of the same name.
    await trip('t_b_srv_3', 'vestra-1', 'p_rahul', 'vestra-prod');
    expect(await browsers.userFor('t_b_srv_3')).toBe(browserUserIdFor('vestra-prod', 'p_rahul'));
  });

  it("takes over the browser the organizer had under the Server's replicas before it gave its name, the one logged in last: no new login", async () => {
    await trip('t_b_old_1', 'rep-a', 'p_aarav');
    await trip('t_b_old_2', 'rep-b', 'p_aarav');
    const a = await browsers.userFor('t_b_old_1');
    const b = await browsers.userFor('t_b_old_2');
    expect(a).not.toBe(b);
    await browsers.setLogin('t_b_old_1', 'in');
    clock.advance(60_000);
    await browsers.setLogin('t_b_old_2', 'in');
    // The Server now sends ?server=vestra from both replicas: its new trips take b, logged in last, and stay on it.
    await trip('t_b_named_1', 'rep-a', 'p_aarav', 'vestra');
    await trip('t_b_named_2', 'rep-b', 'p_aarav', 'vestra');
    expect(await browsers.userFor('t_b_named_1')).toBe(b);
    expect(await browsers.userFor('t_b_named_2')).toBe(b);
    expect(await browsers.login('t_b_named_1')).toMatchObject({ login: 'in' });
    await trip('t_b_named_3', 'rep-c', 'p_aarav', 'vestra');
    expect(await browsers.userFor('t_b_named_3')).toBe(b);
    // A trip already mapped keeps its browser.
    expect(await browsers.userFor('t_b_old_1')).toBe(a);
    // Never another person's: another organizer on the named Server gets their own.
    await trip('t_b_named_4', 'rep-a', 'p_kiara', 'vestra');
    expect(await browsers.userFor('t_b_named_4')).toBe(browserUserIdFor('vestra', 'p_kiara'));
  });

  it('is made on /v1 again when /v1 says it does not know it', async () => {
    const before = fake.callsTo('POST', /^\/v1\/users$/).length;
    expect(await browsers.again('t_b_1')).toBe(browserUserIdFor('try-room-keshav', 'p_rahul'));
    expect(fake.callsTo('POST', /^\/v1\/users$/)).toHaveLength(before + 1);
  });

  it("keeps one ixigo login for all of the person's trips, by status only: in on one trip is in on the other", async () => {
    await trip('t_b_login_1', 'room-login', 'p_rahul');
    await trip('t_b_login_2', 'room-login', 'p_rahul');
    // ixigo never said anything on this browser yet.
    expect(await browsers.login('t_b_login_2')).toBeNull();
    const loggedAt = clock.now();
    await browsers.setLogin('t_b_login_1', 'in');
    expect(await browsers.login('t_b_login_2')).toEqual({ login: 'in', at: loggedAt, loggedInAt: loggedAt });
    // ixigo says in again later: the login is the same one, confirmed now.
    clock.advance(60_000);
    await browsers.setLogin('t_b_login_2', 'in');
    expect(await browsers.login('t_b_login_1')).toEqual({ login: 'in', at: clock.now(), loggedInAt: loggedAt });
    // ixigo refuses its token: out for both, and a new login is a new one.
    clock.advance(60_000);
    await browsers.setLogin('t_b_login_1', 'out');
    expect(await browsers.login('t_b_login_2')).toMatchObject({ login: 'out', at: clock.now() });
    clock.advance(60_000);
    await browsers.setLogin('t_b_login_2', 'in');
    expect(await browsers.login('t_b_login_1')).toMatchObject({ login: 'in', loggedInAt: clock.now() });
  });

  it('lists the browsers logged in whose login ixigo last confirmed before a time, each with its newest live trip', async () => {
    await trip('t_b_keep_old', 'room-keep', 'p_arjun');
    await browsers.setLogin('t_b_keep_old', 'in');
    clock.advance(1_000);
    await trip('t_b_keep_new', 'room-keep', 'p_arjun');
    await browsers.userFor('t_b_keep_new');
    await db.pool.query('update trips set active_at = $2 where trip_id = $1', ['t_b_keep_new', clock.now()]);
    await db.pool.query('update trips set active_at = $2 where trip_id = $1', ['t_b_keep_old', new Date(clock.now().getTime() - 60_000)]);
    clock.advance(4 * 3600_000);
    const due = await browsers.loggedInSince(new Date(clock.now().getTime() - 3 * 3600_000));
    expect(due).toContainEqual(expect.objectContaining({ userId: browserUserIdFor('room-keep', 'p_arjun'), tripId: 't_b_keep_new' }));
    // A trip the Server let go is never the one read; a browser confirmed since the time is not due.
    await db.pool.query('update trips set gone_at = $2 where trip_id = $1', ['t_b_keep_new', clock.now()]);
    expect(await browsers.loggedInSince(new Date(clock.now().getTime() - 3 * 3600_000))).toContainEqual(expect.objectContaining({ tripId: 't_b_keep_old' }));
    await browsers.setLogin('t_b_keep_old', 'in');
    expect((await browsers.loggedInSince(new Date(clock.now().getTime() - 3 * 3600_000))).map((x) => x.tripId)).not.toContain('t_b_keep_old');
  });
});

// The warm and the keepalive moved here from the trip's computer (computer.ts): they wake the browser, by the trip.
describe("the person's browser, awake", () => {
  it('warms the browser, rides a warm from the last minute, and warms again after it; two trips of one person share it', async () => {
    await trip('t_w_1', 'room-warm', 'p_rahul');
    await trip('t_w_2', 'room-warm', 'p_rahul');
    const before = fake.callsTo('POST', /\/warm$/).length;
    expect(await browsers.warm('t_w_1')).toBe('waking');
    expect(await browsers.warm('t_w_2')).toBe('skipped');
    clock.advance(61_000);
    expect(await browsers.warm('t_w_2')).toBe('waking');
    const warms = fake.callsTo('POST', /\/warm$/).slice(before);
    expect(warms).toHaveLength(2);
    expect(warms.every((w) => w.path.includes(browserUserIdFor('room-warm', 'p_rahul')))).toBe(true);
  });

  it('asks Bash to hold the box with keep_ms, never skipped as a repeat, and still counted as a wake', async () => {
    const before = fake.callsTo('POST', /\/warm$/).length;
    await browsers.warm('t_w_1', { keepMs: 120_000 });
    await browsers.warm('t_w_1', { keepMs: 120_000 });
    const warms = fake.callsTo('POST', /\/warm$/).slice(before);
    expect(warms).toHaveLength(2);
    expect(warms[0]!.body).toEqual({ keep_ms: 120_000 });
    // A plain warm right after is still a repeat.
    expect(await browsers.warm('t_w_1')).toBe('skipped');
  });

  it('keeps to 8 computers waking at once across browsers', async () => {
    clock.advance(120_000);
    for (let i = 0; i < 8; i += 1) {
      await trip(`t_wl_${i}`, 'room-limit', `p_w${i}`);
      await browsers.warm(`t_wl_${i}`);
    }
    await trip('t_wl_9', 'room-limit', 'p_w9');
    await expect(browsers.warm('t_wl_9')).rejects.toThrow(/warm_limit/);
    clock.advance(91_000);
    expect(await browsers.warm('t_wl_9')).toBe('waking');
  });

  // The keepalive while a trip's group talks (awake.ts) holds every 30 s: a box Go just saw up is not waking, so its hold
  // never takes a place in Go's count of computers waking, which other trips' real wakes need.
  it("holds the box with keep_ms; a box seen up within its last hold skips Go's wake count, any other counts", async () => {
    clock.advance(200_000);
    fake.warmStatus = 'ready';
    try {
      for (let i = 0; i < 7; i += 1) {
        await trip(`t_hw_${i}`, 'room-hold', `p_h${i}`);
        await browsers.warm(`t_hw_${i}`);
      }
      await trip('t_hold', 'room-hold', 'p_hold');
      await trip('t_hold_other', 'room-hold', 'p_hold_other');
      expect(await browsers.keepAwake('t_hold', 60_000)).toBe('ready');
      expect(fake.callsTo('POST', /\/warm$/).at(-1)!.body).toEqual({ keep_ms: 60_000 });
      // Eight wakes counted in the window: a box seen up 30 s ago still holds; another person's first hold would wake.
      clock.advance(30_000);
      expect(await browsers.keepAwake('t_hold', 60_000)).toBe('ready');
      await expect(browsers.keepAwake('t_hold_other', 60_000)).rejects.toThrow(/warm_limit/);
    } finally {
      fake.warmStatus = 'waking';
    }
  });
});
