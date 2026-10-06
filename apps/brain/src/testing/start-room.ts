// Go on a real port with its own database schema and a given model, every landed lane registered, and @go/sim's
// FakeServer connected to it. P1's end-to-end tests use it; later lanes' end-to-end tests and P3's bench reuse it.
// It lives outside __tests__, so it is built into dist (P3 imports @go/brain/dist/testing/start-room.js).
import { FakeServer } from '@go/sim';
import { buildBrain, type Built, type RegisterLane, type Timings } from '../app.js';
import type { AnthropicLike } from '../composer/anthropic.js';
import { withSchema } from '../db/test-db.js';
import type { TurnRunner } from '../desk/desk.js';
import { loadEnv } from '../env.js';
import { LANES } from '../main.js';

export const SECRET = 'e'.repeat(64);
/** Short waits for tests; everything else runs as in production. */
export const TEST_TIMINGS: Partial<Timings> = { waitMs: 400, deskPollMs: 50, deskRetryMs: [50, 100] };

const firstUser = (body: any): Array<{ type: string; text?: string }> => {
  const content = body?.messages?.[0]?.content;
  return Array.isArray(content) ? content : [];
};
/** The newest messages of a request: the last block of its first user message. */
export const newSince = (body: any): string => String(firstUser(body).at(-1)?.text ?? '');
/** "Right now", with why Go woke: the block before it. */
export const rightNow = (body: any): string => String(firstUser(body).at(-2)?.text ?? '');
/** True when the request answers a round of tool calls. */
export const afterTools = (body: any): boolean => {
  const last = body?.messages?.at(-1);
  return Array.isArray(last?.content) && last.content.some((b: { type: string }) => b.type === 'tool_result');
};
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RoomOptions {
  /** The model: a scripted fake in tests, a recording client in the bench. Every lane's side passes use it too. */
  anthropic: AnthropicLike;
  /** The lanes to register, in boot order. Default: LANES, every lane that has landed. */
  lanes?: RegisterLane[];
  /** Wraps the composer's turn, to make it crash at a chosen moment. */
  wrapTurn?: (run: TurnRunner) => TurnRunner;
  /** The FakeServer's instance name. Default "sim-1". */
  instance?: string;
  /** More environment variables, for a lane under test. */
  env?: Record<string, string>;
  timings?: Partial<Timings>;
}

export interface Room {
  fake: FakeServer;
  built: Built;
  db: Awaited<ReturnType<typeof withSchema>>;
  stop(): Promise<void>;
}

export async function startRoom(o: RoomOptions): Promise<Room> {
  const db = await withSchema();
  const env = loadEnv({
    PORT: '0', DATABASE_URL: process.env.DATABASE_URL, GO_SIGNING_SECRET: SECRET, GO_PUBLIC_URL: 'http://127.0.0.1',
    ANTHROPIC_API_KEY: 'test-key', LOG_LEVEL: 'silent', ...o.env,
  });
  const built = await buildBrain(env, {
    pool: db.pool,
    anthropic: o.anthropic,
    logger: false,
    timings: { ...TEST_TIMINGS, ...o.timings },
    ...(o.wrapTurn ? { wrapTurn: o.wrapTurn } : {}),
  });
  for (const lane of o.lanes ?? LANES) await lane(built.brain);
  const { port } = await built.start();
  const fake = new FakeServer({ goUrl: `http://127.0.0.1:${port}`, secret: SECRET, instance: o.instance ?? 'sim-1' });
  await fake.start(5_000);
  return {
    fake,
    built,
    db,
    async stop() {
      fake.stop();
      await built.stop();
      await db.drop();
    },
  };
}
