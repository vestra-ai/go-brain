import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBrain, type Built } from '../app.js';
import { withSchema } from '../db/test-db.js';
import { loadEnv } from '../env.js';
import { registerRoom } from '../room.js';
import { fakeAnthropic } from './fixtures/fake-anthropic.js';
import { goaSnapshot } from './fixtures/goa.js';
import { rawServer, type RawServer } from './fixtures/raw-server.js';

const SECRET = 'b'.repeat(64);
let db: Awaited<ReturnType<typeof withSchema>>;
let built: Built;
let port: number;
let server: RawServer;

const model = fakeAnthropic(() => ({ text: 'Hi all, I am Go!' }));

beforeAll(async () => {
  db = await withSchema();
  const env = loadEnv({
    PORT: '0', DATABASE_URL: process.env.DATABASE_URL, GO_SIGNING_SECRET: SECRET, GO_PUBLIC_URL: 'http://127.0.0.1',
    ANTHROPIC_API_KEY: 'test-key', LOG_LEVEL: 'silent',
  });
  built = await buildBrain(env, { pool: db.pool, anthropic: model.client, logger: false, timings: { deskPollMs: 50, typingMinMs: 0 } });
  await registerRoom(built.brain);
  ({ port } = await built.start());
  server = await rawServer(`ws://127.0.0.1:${port}/v1/socket?instance=boot-test`, SECRET, (method, params) => {
    if (method === 'post_message') return { message_id: 'm_go_1', seq: 3 };
    if (method === 'read_trip') return goaSnapshot({ trip_id: params.trip_id });
    if (method === 'read_messages') return { messages: [], has_more: false };
    throw { code: -32601, message: `no ${method} here` };
  });
});

afterAll(async () => {
  await server.close();
  await built.stop();
  await db.drop();
});

describe('boot', () => {
  it('serves /v1/health', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
    expect(await r.json()).toEqual({ ok: true, contract: '1.3.0' });
  });

  it('hands every lane the model client it was given, so side passes use the same fake or recorder', async () => {
    expect(built.brain.anthropic).toBe(model.client);
    const before = model.sideBodies.length;
    await built.brain.anthropic.messages.create({ model: built.brain.env.SIDE_MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    expect(model.sideBodies.length).toBe(before + 1);
  });

  it('a new trip on the socket: accepted at once, then hello, and no vote', async () => {
    const answer = await server.call('send_event', {
      event_id: 'ev_boot_1', trip_id: 't_boot', seq: 1, occurred_at: '2026-10-05T02:30:00Z', type: 'trip.created',
      data: { trip: goaSnapshot({ trip_id: 't_boot' }) },
    });
    expect(answer.result).toEqual({ accepted: true, duplicate: false });
    const post = await server.waitFor((f) => f.method === 'post_message', 10_000);
    expect(post.id).toMatch(/^go_/);
    expect(post.params).toMatchObject({ trip_id: 't_boot', text: 'Hi all, I am Go!' });
    expect(post.params.card).toBeUndefined();
    expect(server.frames.filter((f) => f.method === 'open_vote')).toEqual([]);
  });

  it('a tap on a card Go does not know is refused kindly', async () => {
    const a = await server.call('card_tap', { tap_id: 'tap_boot_1', trip_id: 't_boot', card_id: 'c_nope', action_id: 'watch', person_id: 'p_priya' });
    expect(a.result).toEqual({ result: 'refused', toast: 'That card is not active any more.' });
  });

  it('each lane registers once: a second registerRoom is refused', () => {
    expect(() => registerRoom(built.brain)).toThrow(/already/);
  });
});

describe('stopping', () => {
  it('runs the lanes\' stoppers in reverse order, each awaited, and one that throws does not stop the rest', async () => {
    // A second Go on the same schema, never started: only its stop() is under test.
    const other = await buildBrain(built.brain.env, { pool: db.pool, anthropic: model.client, logger: false });
    const ran: string[] = [];
    other.brain.onStop(() => {
      ran.push('first');
    });
    other.brain.onStop(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      ran.push('second');
    });
    other.brain.onStop(() => {
      throw new Error('this lane could not stop');
    });
    other.brain.onStop(() => {
      ran.push('fourth');
    });
    await expect(other.stop()).resolves.toBeUndefined();
    // 'second' before 'first' shows each stopper is awaited before the next one runs.
    expect(ran).toEqual(['fourth', 'second', 'first']);
    await other.stop();
    expect(ran).toEqual(['fourth', 'second', 'first']);
  });
});
