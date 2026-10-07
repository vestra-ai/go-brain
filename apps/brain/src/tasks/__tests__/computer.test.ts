import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { createTokenStore, type TokenStore } from '../../mcp/tokens.js';
import { addComputerSteps, createComputer, v1UserIdFor, type Computer } from '../computer.js';
import { FakeV1 } from '../testing/fake-v1.js';
import { FakeClock, FakeSetup, TEST_START_MS } from '../testing/lane-brain.js';
import { createV1Client } from '../v1-client.js';

const KEYS = [`vk_test_${'a'.repeat(43)}`, `vk_test_${'b'.repeat(43)}`];
const ADMIN = `vk_test_${'z'.repeat(43)}`;
let db: Awaited<ReturnType<typeof withSchema>>;
let fake: FakeV1;
let clock: FakeClock;
let tokens: TokenStore;
let computer: Computer;
const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

beforeAll(async () => {
  db = await withSchema();
  clock = new FakeClock(TEST_START_MS);
  fake = new FakeV1({ keys: KEYS, adminKey: ADMIN, now: clock.now });
  await fake.start();
  const v1 = createV1Client({ baseUrl: fake.url, keys: KEYS, adminKey: ADMIN, sleep: async () => undefined });
  tokens = createTokenStore(db.pool, clock.now);
  computer = createComputer({ pool: db.pool, v1, tokens, env: { VESTRA_DEPLOYMENT_ID: 'dep_go', VESTRA_MCP_SERVER_ID: 'mcp_go' }, now: clock.now, log });
});
afterAll(async () => {
  await fake.close();
  await db.drop();
});

describe("the trip's computer", () => {
  it('creates the trip user once, with the admin key, and points it at the go-trip-task deployment', async () => {
    const userId = await computer.ensureUser('t_goa');
    expect(userId).toBe(v1UserIdFor('t_goa'));
    expect(userId).toMatch(/^gotrip-[0-9a-f]{32}$/);
    await computer.ensureUser('t_goa');
    const posts = fake.callsTo('POST', /^\/v1\/users$/);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers.authorization).toBe(`Bearer ${ADMIN}`);
    expect(posts[0]!.body).toMatchObject({ user_id: userId, timezone: 'Asia/Kolkata', metadata: { go_trip_id: 't_goa' } });
    expect(fake.users.get(userId)?.default_deployment).toBe('dep_go');
  });

  it('warms the computer, rides a warm from the last minute, and warms again after it', async () => {
    expect(await computer.warm('t_goa')).toBe('waking');
    expect(await computer.warm('t_goa')).toBe('skipped');
    clock.advance(61_000);
    expect(await computer.warm('t_goa')).toBe('waking');
    expect(fake.callsTo('POST', /\/warm$/)).toHaveLength(2);
  });

  it('asks Bash to hold the box with keep_ms, never skipped as a repeat, and still counted as a wake', async () => {
    const before = fake.callsTo('POST', /\/warm$/).length;
    await computer.warm('t_goa', { keepMs: 120_000 });
    await computer.warm('t_goa', { keepMs: 120_000 });
    const warms = fake.callsTo('POST', /\/warm$/).slice(before);
    expect(warms).toHaveLength(2);
    expect(warms[0]!.body).toEqual({ keep_ms: 120_000 });
    // A plain warm right after is still a repeat.
    expect(await computer.warm('t_goa')).toBe('skipped');
  });

  it('keeps to 8 computers waking at once across trips', async () => {
    clock.advance(120_000);
    for (let i = 0; i < 8; i += 1) await computer.warm(`t_warm_${i}`);
    await expect(computer.warm('t_warm_9')).rejects.toThrow(/warm_limit/);
    clock.advance(91_000);
    expect(await computer.warm('t_warm_9')).toBe('waking');
  });

  it('opens one conversation for each job, on the go-trip-task deployment, the same one when a hand-off runs again', async () => {
    const a = await computer.conversation('t_goa', 'gt_conv_a');
    const again = await computer.conversation('t_goa', 'gt_conv_a');
    const b = await computer.conversation('t_goa', 'gt_conv_b');
    expect(again).toEqual(a);
    expect(b.conversationId).not.toBe(a.conversationId);
    expect(b.userId).toBe(a.userId);
    const creates = fake.callsTo('POST', /^\/v1\/conversations$/);
    expect(creates.map((c) => c.headers['idempotency-key'])).toEqual(['go-conv-gt_conv_a', 'go-conv-gt_conv_a', 'go-conv-gt_conv_b']);
    expect(creates[0]!.body).toMatchObject({ user_id: v1UserIdFor('t_goa'), deployment: 'dep_go', metadata: { go_trip_id: 't_goa', go_task_id: 'gt_conv_a' } });
  });

  it('arms a fresh TRIP_TOKEN in the body of PUT /v1/secrets, checks it reaches Go, and the token names the trip', async () => {
    await computer.armToken('t_goa', new Date(clock.ms + 23 * 60_000));
    const put = fake.callsTo('PUT', /^\/v1\/secrets\/TRIP_TOKEN$/).at(-1)!;
    expect(put.body.user_id).toBe(v1UserIdFor('t_goa'));
    expect(put.query.user_id).toBeUndefined();
    expect(await tokens.tripFor(put.body.value)).toBe('t_goa');
    expect(fake.callsTo('POST', /^\/v1\/mcp-servers\/mcp_go\/check$/).at(-1)!.body).toEqual({ user_id: v1UserIdFor('t_goa') });
  });

  it('puts the secret again when the check fails, then carries on and says so in the log', async () => {
    fake.checkOk = false;
    const before = fake.callsTo('PUT', /TRIP_TOKEN/).length;
    await computer.armToken('t_goa', new Date(clock.ms + 23 * 60_000));
    expect(fake.callsTo('PUT', /TRIP_TOKEN/).length - before).toBe(2);
    expect(log.warn).toHaveBeenCalled();
    fake.checkOk = null;
  });

  it("revokes every token of a trip when its jobs end", async () => {
    await computer.armToken('t_goa', new Date(clock.ms + 23 * 60_000));
    const token = fake.callsTo('PUT', /TRIP_TOKEN/).at(-1)!.body.value as string;
    await computer.releaseTokens('t_goa');
    expect(await tokens.tripFor(token)).toBeNull();
  });

  it("adds the setup step computer.user, and a new trip's box is not woken", async () => {
    const setup = new FakeSetup();
    addComputerSteps(setup, computer);
    expect(setup.steps.map((s) => [s.name, s.after])).toEqual([['computer.user', undefined]]);
    const warmsBefore = fake.callsTo('POST', /\/warm$/).length;
    clock.advance(120_000);
    await setup.ensureTrip('t_new');
    expect(fake.users.has(v1UserIdFor('t_new'))).toBe(true);
    expect(fake.callsTo('POST', /\/warm$/)).toHaveLength(warmsBefore);
  });
});
